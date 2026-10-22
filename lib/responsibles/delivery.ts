import type pg from "pg";
import { z } from "zod";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import { cancelJob, rescheduleJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { ApiError } from "@/lib/api/types";
import type { SendMessageInput } from "@/lib/schemas";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { storagePathFor } from "@/lib/messaging/media/types";

const payloadSchema = z.object({ delivery_id: z.string().uuid() });
/** Disposição já persistida. O daemon não completa/re-tenta uma espera de canal. */
export class ResponsibleJobSettledError extends Error { readonly terminal = true; }
interface Delivery {
  id: string; request_id: string; responsible_id: string | null; purpose: string;
  target_conversation_id: string; target_contact_id: string; source_message_id: string | null;
  body: string | null; status: string; kind: string; request_status: string; case_id: string;
  contact_id: string; conversation_id: string; channel_session_id: string; agent_id: string;
  target_phone: string | null; target_identity: string | null; target_lid: string | null;
}

/** Não há modelo neste caminho. A resposta foi escrita/gravada pelo responsável. */
export function createResponsibleDeliveryHandler(deps: { crmCfg: CrmEdgeConfig; knobs: { queuedRetryDelayMs: number } }) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }) => {
    const { delivery_id: id } = payloadSchema.parse(job.payload);
    const org = job.organization_id;
    const { rows } = await pool.query<Delivery>(`select d.*,r.kind,r.status as request_status,r.case_id,r.contact_id,r.conversation_id,r.agent_id,
      v.channel_session_id,t.phone_number as target_phone,t.wa_identity as target_identity,t.wa_lid as target_lid from agent_responsible_deliveries d
      join agent_responsible_requests r on r.id=d.request_id and r.organization_id=d.organization_id
      join conversations v on v.id=d.target_conversation_id and v.organization_id=d.organization_id
      join contacts t on t.id=d.target_contact_id and t.organization_id=d.organization_id
      where d.organization_id=$1 and d.id=$2 and d.job_id=$3 and d.target_contact_id=$4`, [org, id, job.id, job.contact_id]);
    const d = rows[0];
    if (!d || ["sent", "blocked", "uncertain"].includes(d.status)) return;
    try {
    const assertLive = async () => {
      const { rows } = await pool.query(`select 1 from agent_responsible_requests r
        join agent_responsible_deliveries d on d.request_id=r.id and d.organization_id=r.organization_id
        join contacts c on c.id=r.contact_id and c.organization_id=r.organization_id
        join conversations v on v.id=r.conversation_id and v.organization_id=r.organization_id
        join contacts target on target.id=d.target_contact_id and target.organization_id=d.organization_id
        join conversations dest on dest.id=d.target_conversation_id and dest.organization_id=d.organization_id
        join channel_sessions ch on ch.id=dest.channel_session_id and ch.organization_id=dest.organization_id
        join job_queue j on j.id=d.job_id and j.organization_id=d.organization_id
        where r.organization_id=$1 and d.id=$2 and j.id=$3 and j.status='running' and j.locked_by=$4
          and not c.is_blocked and not c.is_anonymized and not target.is_blocked and not target.is_anonymized
          and v.contact_id=r.contact_id and v.status not in ('closed','archived')
          and dest.status not in ('closed','archived') and ch.archived_at is null and ch.provider='waha'
          and dest.contact_id=d.target_contact_id and dest.channel_session_id=v.channel_session_id
          and (d.purpose='receipt' or
            (r.status='pending' and d.purpose in ('notification','wait_notice')) or (r.status='answered' and d.purpose='answer'))
          and (d.purpose not in ('answer','wait_notice') or r.kind='handoff' or
            (not c.force_human and v.assignee_kind is distinct from 'user' and (v.bot_silenced_until is null or v.bot_silenced_until<=now())))
          and (d.responsible_id is null or exists(select 1 from agent_responsibles p
            join agent_responsible_bindings b on b.responsible_id=p.id and b.organization_id=p.organization_id
            join agent_responsible_settings s on s.organization_id=b.organization_id and s.agent_id=b.agent_id
            where p.organization_id=$1 and p.id=d.responsible_id and p.enabled and s.enabled and s.agent_id=r.agent_id))`, [org, id, job.id, ctx.workerId]);
      if (!rows.length) throw new ApiError(403, "forbidden", undefined, id, "responsible_delivery_no_longer_authorized");
    };

    let prepared: SendMessageInput = { conversation_id: d.target_conversation_id, type: "text", body: d.body ?? undefined };
    if (d.purpose === "notification") {
      const data = await pool.query<{ workspace: string; name: string | null; phone: string | null; summary: string; blocker: string }>(`select o.display_name as workspace,c.name,c.phone_number as phone,a.summary,a.blocker
        from agent_responsible_requests r join organizations o on o.id=r.organization_id
        join contacts c on c.id=r.contact_id and c.organization_id=r.organization_id
        join agent_cases a on a.id=r.case_id and a.organization_id=r.organization_id where r.organization_id=$1 and r.id=$2`, [org, d.request_id]);
      const c = data.rows[0];
      if (!c) return;
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      let origin = "";
      try { const parsed = new URL(base); if (parsed.protocol === "https:" || ["localhost","127.0.0.1"].includes(parsed.hostname)) origin=parsed.origin; } catch { /* link relativo quando a instalação não informou a URL pública */ }
      const link = origin ? `${origin}/app/inbox?id=${d.conversation_id}` : "/app/ai/cases";
      prepared.body = [`${c.workspace.slice(0,120)} | ${d.kind === "handoff" ? "Pedido de atendimento humano" : "Consulta ao responsável"} #${d.request_id.slice(0, 8)}`,
        `Cliente: ${(c.name ?? "Sem nome informado").slice(0,120)}${c.phone ? ` (${c.phone})` : ""}`, `Resumo: ${c.summary.slice(0, 1400)}`, `Pergunta pendente: ${c.blocker.slice(0, 1000)}`,
        `Atendimento: ${link}`, "Use Responder sobre este aviso. Seu texto ou áudio será entregue ao cliente como você enviar."].join("\n\n");
    }
    if (d.purpose === "answer" && d.source_message_id) {
      const source = await pool.query<{ type: string; body: string | null; media_storage_path: string | null; media_mime: string | null; media_size_bytes: number | null; conversation_id: string; metadata: Record<string, unknown> }>(
        `select type,body,media_storage_path,media_mime,media_size_bytes,conversation_id,metadata from messages
         where organization_id=$1 and id=$2 and direction='inbound' and metadata->>'responsible_id'=$3`, [org, d.source_message_id, d.responsible_id]);
      const m = source.rows[0];
      if (!m) throw new Error("responsible_source_missing");
      if (m.type === "audio") {
        if (!m.media_storage_path) {
          if (m.metadata?.media_status === "failed") throw new Error("responsible_audio_unavailable");
          await rescheduleJob(pool, job.id, ctx.workerId, { delayMs: 30_000, reason: "responsible_audio_pending_storage" });
          throw new ResponsibleJobSettledError("responsible_audio_pending_storage");
        }
        if (!m.media_mime?.startsWith("audio/") || !isMediaPathOwnedBy(m.media_storage_path, org, m.conversation_id)) throw new Error("responsible_audio_invalid");
        const path = storagePathFor(org, d.target_conversation_id, d.id, m.media_mime);
        await assertLive();
        await pool.query("update agent_responsible_deliveries set media_storage_path=$3 where organization_id=$1 and id=$2", [org,id,path]);
        const copied = await deps.crmCfg.supabase.storage.from("whatsapp-media").copy(m.media_storage_path, path);
        await pool.query("update agent_responsible_deliveries set media_storage_path=$3 where organization_id=$1 and id=$2", [org,id,path]);
        if (copied.error && String(copied.error.statusCode) !== "409") throw new Error("responsible_audio_copy_failed");
        prepared = { conversation_id: d.target_conversation_id, type: "audio", media_storage_path: path,
          media_mime: m.media_mime, ...(m.media_size_bytes ? { media_size_bytes: m.media_size_bytes } : {}) };
      } else if (m.type === "text") prepared.body = d.body ?? undefined;
      else throw new Error("responsible_format_invalid");
    }
    prepared.metadata = { responsible_request_id: d.request_id, responsible_delivery_id: d.id,
      responsible_recipient: { phone: d.target_phone, identity: d.target_identity, lid: d.target_lid },
      responsible_internal: ["notification", "receipt"].includes(d.purpose), responsible_id: d.responsible_id };
    try {
      const outcome = await sendTurnMessage(pool, deps.crmCfg, { tenantId: org, leadId: d.target_contact_id,
        workerId: ctx.workerId, jobId: job.id, seq: 1, conversationId: d.target_conversation_id,
        body: prepared.body ?? "", beforePersist: assertLive }, {
        actor: { type: "responsible", id: d.responsible_id ?? d.id }, prepare: async () => prepared,
      });
      if (outcome.kind === "queued") {
        await rescheduleJob(pool, job.id, ctx.workerId, { delayMs: deps.knobs.queuedRetryDelayMs, reason: "responsible_channel_queued" });
        throw new ResponsibleJobSettledError("responsible_channel_queued");
      }
      if (outcome.kind !== "sent" && outcome.kind !== "already_sent") {
        const phase = "crmMessageId" in outcome && outcome.crmMessageId ? (await pool.query<{ metadata: { outbound_attempt?: { phase?: string } } }>(
          "select metadata from messages where organization_id=$1 and id=$2", [org,outcome.crmMessageId])).rows[0]?.metadata?.outbound_attempt?.phase : null;
        const status = outcome.kind === "blocked" ? "blocked" : phase === "prepared" ? "failed" : "uncertain";
        await pool.query(`update agent_responsible_deliveries set status=$3,message_id=$4 where organization_id=$1 and id=$2`, [org, id, status, "crmMessageId" in outcome ? outcome.crmMessageId : null]);
        if (status === "failed") throw new Error("responsible_delivery_before_network_failed");
        await cancelJob(pool,job.id,ctx.workerId,status === "blocked" ? "responsible_delivery_blocked" : "responsible_delivery_uncertain");
        throw new ResponsibleJobSettledError(status);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const owner = await client.query("select id from job_queue where organization_id=$1 and id=$2 and status='running' and locked_by=$3 for update", [org,job.id,ctx.workerId]);
        if (!owner.rows.length) throw new Error("responsible_delivery_lease_lost");
        await client.query("select id from agent_cases where organization_id=$1 and id=$2 for update", [org,d.case_id]);
        const changed = await client.query(`update agent_responsible_deliveries set status='sent',message_id=$3
          where organization_id=$1 and id=$2 and status<>'sent' returning id`, [org, id, outcome.crmMessageId]);
        if (changed.rows.length && d.purpose === "answer") {
          const delivered = await client.query(`update agent_responsible_requests set status='delivered',delivered_at=now()
            where organization_id=$1 and id=$2 and status='answered' returning id,kind`, [org, d.request_id]);
          if (delivered.rows.length) {
            if (delivered.rows[0].kind === "consultation") await client.query(`update agent_cases set status='resolved',closed_at=now(),updated_at=now()
              where organization_id=$1 and id=$2 and status in ('awaiting_human','awaiting_lead')`, [org, d.case_id]);
            await client.query(`insert into agent_case_events(organization_id,case_id,kind,actor_kind,human_action,body,metadata)
              values($1,$2,'human_replied','human',$5,$6,jsonb_build_object('responsible_id',$3::text,'message_id',$4::text,'delivery_status','sent'))`, [org, d.case_id, d.responsible_id, outcome.crmMessageId,
              delivered.rows[0].kind === "consultation" ? "resolved" : null,
              d.body ?? "O responsável respondeu em áudio e a entrega foi confirmada. Sem transcrição disponível; não invente o conteúdo do áudio."]);
            await client.query(`select public.fn_queue_responsible_delivery($1,$2,n.responsible_id,'receipt',n.target_conversation_id,n.target_contact_id,
              case when n.responsible_id=$3 then 'Sua resposta foi entregue ao cliente.' else 'Este pedido já foi atendido por outro responsável.' end)
              from agent_responsible_deliveries n where n.organization_id=$1 and n.request_id=$2 and n.purpose='notification'`, [org, d.request_id, d.responsible_id]);
          }
        }
        await client.query("commit");
      } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
    } catch (e) {
      if (e instanceof ResponsibleJobSettledError) throw e;
      await pool.query(`update agent_responsible_deliveries set status='failed' where organization_id=$1 and id=$2 and status in ('pending','sending')`, [org, id]);
      throw e;
    }
    } catch (error) {
      if (error instanceof ResponsibleJobSettledError) throw error;
      await pool.query(`update agent_responsible_deliveries set status='failed' where organization_id=$1 and id=$2 and status in ('pending','sending')`, [org,id]);
      throw error;
    }
  };
}
