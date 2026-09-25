import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { OutboundLeaseLostError } from "@/lib/channels/delivery-error";
import type { Message } from "@/lib/types/messaging";
import type { SendMessageInput } from "@/lib/schemas";
import type { ActionCtx } from "./types";
import { adiarAteAJanelaAbrir } from "./janela-do-canal";
import { checkDailyLimit } from "./throttle";
import { ApiError } from "@/lib/api/types";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import { reportarEnvio } from "./desfecho-do-envio";
import type { ActionResultDetail } from "./types";

/** Reusa o sink e seu protocolo prepared → started → rejected/uncertain.
 * A aquisição pertence ao run, em vez do job_queue do agente. Não existe
 * retomada de transporte iniciado. Uma espera PREPARED pode continuar pelo
 * mesmo intent/mensagem; nunca pelo redrive legado do watchdog.
 */
export async function sendAutomationMessage(ctx: ActionCtx, input: SendMessageInput) {
  const handlerCtx = { organization_id: ctx.organizationId,
    actor: { type: "webhook_source" as const, id: ctx.ruleId }, requestId: `rule:${ctx.ruleId}` };
  const id = ctx.actionIntentId;
  if (!id) return sendMessageHandler(ctx.admin, handlerCtx, input);
  const db = getRequestPool();
  const org = ctx.organizationId;
  return sendMessageHandler(ctx.admin, handlerCtx, {
    ...input, metadata: { ...input.metadata, idempotency_key: id,
      automation_send_input: { ...input, metadata: undefined },
      automation_prepared_phone: (ctx.context.contact as { phone_number?: string } | undefined)?.phone_number,
      outbound_attempt: { phase: "prepared" } },
  }, {
    messageId: id,
    beforeSend: async (message) => {
      const { rows } = await db.query(`update automation_rule_runs r set message_id=m.id
        from messages m where r.id=$1 and r.organization_id=$2 and r.execution_state='preparing'
        and m.id=$3 and m.organization_id=r.organization_id returning r.id`, [id,org,message.id]);
      if (!rows.length) throw new OutboundLeaseLostError();
    },
    beforeTransport: async (message) => {
      if (await adiarAteAJanelaAbrir(ctx.admin,org,message.channel_session_id)) {
        throw new ApiError(403,"forbidden",undefined,ctx.requestId,"fora_da_janela_de_envio");
      }
      if (!(await checkDailyLimit(ctx.admin,org,message.channel_session_id)).allowed) {
        throw new ApiError(403,"forbidden",undefined,ctx.requestId,"daily_limit");
      }
      const { rows } = await db.query(`with eligible as materialized (
        select m.id,c.phone_number from messages m join contacts c on c.id=m.contact_id
          and c.organization_id=m.organization_id where m.id=$3 and m.organization_id=$2
          and not c.is_blocked and not c.is_anonymized and c.phone_number=$4
          and public.fn_automation_run_live($2,$1,c.id)
          and coalesce(c.consent #> '{marketing,declined_at}','null'::jsonb) in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
          and m.metadata->'outbound_attempt'->>'phase'='prepared' for update of c
      ), acquired as (
        update automation_rule_runs set execution_state='sending',execution_updated_at=now()
        where id=$1 and organization_id=$2 and execution_state='preparing'
          and exists(select 1 from eligible) returning id
      ) update messages m set status='sending',
        metadata=jsonb_set(m.metadata,'{outbound_attempt,phase}','"started"'::jsonb)
          || jsonb_build_object('automation_destination_phone',c.phone_number)
        from contacts c where m.id=$3 and m.organization_id=$2 and exists(select 1 from acquired)
          and c.id=m.contact_id and c.organization_id=m.organization_id
          and not c.is_blocked and not c.is_anonymized
          and m.metadata->'outbound_attempt'->>'phase'='prepared' returning m.id`,
        [id,org,message.id,(ctx.context.contact as { phone_number?: string } | undefined)?.phone_number]);
      if (!rows.length) throw new ApiError(403,"forbidden",undefined,ctx.requestId,"recipient_changed");
    },
    writeAttemptState: async (message, change) => {
      const patch = change.patch;
      const blocked = patch.error_code === "automatic_send_blocked";
      // Só PREPARED comprova que nenhum transporte começou. Um adaptador que
      // pede queued depois de STARTED não ganha autorização para repetir.
      const waiting = patch.status === "queued" && change.expectedPhase === "prepared";
      const unconfirmed = patch.status === "sent" && !patch.external_id;
      const uncertain = unconfirmed || (patch.status === "queued" && !waiting);
      const state = uncertain ? "uncertain" : waiting ? "preparing" : patch.status === "sent" ? "accepted"
        : change.phase === "uncertain" ? "uncertain"
        : change.phase === "rejected" ? "rejected"
        : blocked ? "blocked" : "failed_before_send";
      const { rows } = await db.query<Message>(`with acquired as (
        update automation_rule_runs set execution_state=$4,execution_updated_at=now()
        where id=$1 and organization_id=$2 and (execution_state=$5
          or (execution_state='uncertain' and $5='sending' and $4='accepted')) returning id
      ) update messages m set
        status=case when m.status in ('delivered','read') then m.status else $6 end,
        external_id=coalesce($7,m.external_id),error_code=$8,error_message=null,
        ack=case when $10::integer is null then m.ack else greatest(m.ack,$10::integer) end,
         metadata=jsonb_set(m.metadata,'{outbound_attempt,phase}',to_jsonb($9::text))
           || case when $11::text is null then '{}'::jsonb else jsonb_build_object('queued_reason',$11::text) end
        where m.id=$3 and m.organization_id=$2 and exists(select 1 from acquired) returning m.*`,
      [id,org,message.id,state,change.expectedPhase === "started" ? "sending" : "preparing",
        uncertain ? "failed" : patch.status,patch.external_id ?? null,
        uncertain ? "outbound_delivery_uncertain" : blocked ? patch.error_message : change.queuedReason ?? patch.error_code ?? null,
        uncertain ? "uncertain" : change.phase,patch.ack ?? null,waiting ? change.queuedReason ?? "awaiting_processing" : null]);
      if (!rows[0]) throw new OutboundLeaseLostError();
      return rows[0];
    },
  }).catch(async (error: unknown) => {
    if (error instanceof ApiError && error.status === 403) {
      await db.query("update automation_rule_runs set execution_state='blocked',execution_updated_at=now() where id=$1 and organization_id=$2 and execution_state='preparing'",[id,org]);
    }
    throw error;
  });
}

/** Continuação de uma espera, não uma nova execução da ação (nem nova geração
 * de IA/template). Pending só é publicado por finishActionIntent, depois que
 * o executor anterior terminou. CAS e fase PREPARED elegem um único worker. */
export async function resumeQueuedAutomationMessage(ctx: ActionCtx, index: number, type: string): Promise<{ id: string; result: ActionResultDetail } | null> {
  if (!["send_whatsapp_message", "send_ai_message"].includes(type)) return null;
  const db = getRequestPool();
  const { rows } = await db.query<{ id: string; input: unknown; phone: string | null }>(`
    update automation_rule_runs r set execution_state='preparing',execution_updated_at=now()
    from messages m where r.organization_id=$1 and r.event_id=$2 and r.rule_identity=$3 and r.action_index=$4
      and r.execution_state='pending' and r.status='adiado'
      and m.organization_id=r.organization_id and m.id=r.message_id
      and m.status='queued' and m.external_id is null
      and m.metadata->'outbound_attempt'->>'phase'='prepared'
      and public.fn_automation_run_live($1,r.id,m.contact_id)
    returning r.id,m.metadata->'automation_send_input' as input,m.metadata->>'automation_prepared_phone' as phone`,
  [ctx.organizationId, ctx.event.id, ctx.ruleId, index]);
  const claimed = rows[0];
  if (!claimed) return null;
  const input = sendMessageSchema.safeParse(claimed.input);
  if (!input.success || !claimed.phone) return { id: claimed.id, result: { type, status: "failed", error: "invalid_config" } };
  try {
    const message = await sendAutomationMessage({ ...ctx, actionIntentId: claimed.id,
      context: { ...ctx.context, contact: { ...(ctx.context.contact as object), phone_number: claimed.phone } },
    }, input.data);
    return { id: claimed.id, result: await reportarEnvio(ctx, type, message, input.data.conversation_id) };
  } catch {
    return { id: claimed.id, result: { type, status: "failed", error: "action_failed" } };
  }
}
