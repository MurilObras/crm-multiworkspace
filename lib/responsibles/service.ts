import type pg from "pg";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { DEFAULT_CONSULTATION, type ConsultationSettings } from "./config";
import { supportsResponsibleReplies, type ChannelProvider } from "@/lib/channels/capabilities";

export interface Responsible { id: string; name: string; phone: string; enabled: boolean }

export async function readResponsibleSettings(db: Queryable, org: string, agent: string) {
  const a = await db.query("select id from ai_agents where organization_id=$1 and id=$2 and archived_at is null", [org, agent]);
  if (!a.rows.length) return null;
  const [settings, bindings, recipients] = await Promise.all([
    db.query<{ enabled: boolean; conditions: string }>("select enabled,conditions from agent_responsible_settings where organization_id=$1 and agent_id=$2", [org, agent]),
    db.query<{ responsible_id: string }>("select responsible_id from agent_responsible_bindings where organization_id=$1 and agent_id=$2 order by responsible_id", [org, agent]),
    db.query<Responsible>("select id,name,phone,enabled from agent_responsibles where organization_id=$1 order by name,id", [org]),
  ]);
  return { settings: { ...DEFAULT_CONSULTATION, ...settings.rows[0], recipient_ids: bindings.rows.map(r => r.responsible_id) }, recipients: recipients.rows };
}

export async function saveResponsibleSettings(pool: pg.Pool, org: string, agent: string, settings: ConsultationSettings) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const a = await db.query("select id from ai_agents where organization_id=$1 and id=$2 and archived_at is null for update", [org, agent]);
    if (!a.rows.length) throw new Error("agent_not_found");
    const ids = [...new Set(settings.recipient_ids)];
    const previous = await db.query<{ responsible_id: string }>("select responsible_id from agent_responsible_bindings where organization_id=$1 and agent_id=$2", [org,agent]);
    const changesRecipients = previous.rows.map(r=>r.responsible_id).sort().join(",") !== [...ids].sort().join(",");
    if (!settings.enabled || changesRecipients) {
      const pending = await db.query("select id from agent_responsible_requests where organization_id=$1 and agent_id=$2 and status in ('pending','answered','failed') limit 1", [org,agent]);
      if (pending.rows.length) throw new Error("settings_have_pending_requests");
    }
    const valid = await db.query("select id from agent_responsibles where organization_id=$1 and id=any($2::uuid[]) and enabled for share", [org, ids]);
    if (valid.rows.length !== ids.length) throw new Error("recipient_unavailable");
    if (settings.enabled) {
      const channel = await db.query<{provider:ChannelProvider}>(`select ch.provider from ai_agents a join ai_agent_versions v
        on v.organization_id=a.organization_id and v.id=coalesce(a.published_version_id,
          (select draft.id from ai_agent_versions draft where draft.organization_id=a.organization_id and draft.agent_id=a.id order by draft.version_number desc limit 1))
        join channel_sessions ch on ch.organization_id=v.organization_id and ch.id=v.channel_session_id
        where a.organization_id=$1 and a.id=$2 and ch.archived_at is null`,[org,agent]);
      if (!supportsResponsibleReplies(channel.rows[0]?.provider)) throw new Error("responsible_channel_unavailable");
      const self = await db.query(`select r.id from agent_responsibles r join channel_sessions s on s.organization_id=r.organization_id and s.phone_number=r.phone
        where r.organization_id=$1 and r.id=any($2::uuid[]) and s.archived_at is null`, [org, ids]);
      if (self.rows.length) throw new Error("recipient_is_channel");
    }
    await db.query(`insert into agent_responsible_settings(organization_id,agent_id,enabled,conditions) values($1,$2,$3,$4)
      on conflict(organization_id,agent_id) do update set enabled=excluded.enabled,conditions=excluded.conditions`, [org, agent, settings.enabled, settings.conditions]);
    await db.query("delete from agent_responsible_bindings where organization_id=$1 and agent_id=$2", [org, agent]);
    for (const id of ids) await db.query("insert into agent_responsible_bindings(organization_id,agent_id,responsible_id) values($1,$2,$3)", [org, agent, id]);
    await db.query("commit");
  } catch (e) { await db.query("rollback"); throw e; } finally { db.release(); }
}

export async function saveResponsible(pool: pg.Pool, org: string, value: Omit<Responsible, "id">, id?: string) {
  const phone = canonicalPhoneBR(value.phone);
  const db = await pool.connect();
  try {
  await db.query("begin");
  const self = await db.query(`select id from channel_sessions where organization_id=$1
    and archived_at is null and '+'||regexp_replace(phone_number,'[^0-9]','','g')=$2 limit 1`, [org,phone]);
  if (self.rows.length) throw new Error("recipient_is_channel");
  if (id) {
    const locked = await db.query("select id from agent_responsibles where organization_id=$1 and id=$2 for update", [org,id]);
    if (!locked.rows.length) { await db.query("commit"); return null; }
    if (!value.enabled) {
      const assigned = await db.query(`select 1 from agent_responsible_bindings b join agent_responsible_settings s on s.organization_id=b.organization_id and s.agent_id=b.agent_id
        where b.organization_id=$1 and b.responsible_id=$2 and s.enabled limit 1`, [org,id]);
      if (assigned.rows.length) throw new Error("recipient_still_assigned");
    }
    const busy = await db.query(`select r.id from agent_responsibles r where r.organization_id=$1 and r.id=$2
      and (r.phone<>$3 or not $4::boolean) and exists(select 1 from agent_responsible_requests q
        join agent_responsible_bindings b on b.organization_id=q.organization_id and b.agent_id=q.agent_id
        where q.organization_id=r.organization_id and b.responsible_id=r.id and q.status in ('pending','answered','failed'))`, [org, id, phone, value.enabled]);
    if (busy.rows.length) throw new Error("recipient_has_pending_requests");
    const result = (await db.query<Responsible>(`update agent_responsibles set name=$3,phone=$4,enabled=$5
      where organization_id=$1 and id=$2 returning id,name,phone,enabled`, [org, id, value.name, phone, value.enabled])).rows[0] ?? null;
    await db.query("commit"); return result;
  }
  const result = (await db.query<Responsible>(`insert into agent_responsibles(organization_id,name,phone,enabled)
    values($1,$2,$3,$4) returning id,name,phone,enabled`, [org, value.name, phone, value.enabled])).rows[0];
  await db.query("commit"); return result;
  } catch(e) { await db.query("rollback"); throw e; } finally { db.release(); }
}

/** Um número cadastrado é um canal interno, nunca um lead a qualificar pelo bot. */
export async function internalResponsible(db: Queryable, org: string, phone: string | null): Promise<Responsible | null> {
  if (!phone) return null;
  return (await db.query<Responsible>("select id,name,phone,enabled from agent_responsibles where organization_id=$1 and phone=$2", [org, canonicalPhoneBR(phone)])).rows[0] ?? null;
}

export async function waitingForResponsible(db: Queryable, org: string, contact: string): Promise<boolean> {
  const r = await db.query<{ waiting: boolean }>("select public.fn_responsible_waiting($1,$2) as waiting", [org, contact]);
  return r.rows[0]?.waiting === true;
}

/** Gera também um chamado para pedidos explícitos de humano. Não desfaz o handoff. */
export async function notifyHandoff(db: Queryable, org: string, conversation: string, agentId: string | null, summary: string) {
  if (!agentId) return;
  const enabled = await db.query(`select 1 from agent_responsible_settings s where organization_id=$1 and agent_id=$2 and enabled`, [org, agentId]);
  if (!enabled.rows.length) return;
  const existing = await db.query<{ id: string }>(`select id from agent_cases where organization_id=$1 and conversation_id=$2
    and status in ('awaiting_human','awaiting_lead') order by created_at desc limit 1`, [org, conversation]);
  let caseId = existing.rows[0]?.id;
  if (!caseId) {
    const created = await db.query<{ id: string }>(`insert into agent_cases(organization_id,conversation_id,agent_id,title,summary,blocker,context_snapshot)
      values($1,$2,$3,'Pedido de atendimento humano',$4,'O cliente pediu atendimento de uma pessoa.', '{"responsible_kind":"handoff"}') returning id`, [org, conversation, agentId, summary]);
    caseId = created.rows[0]?.id;
    if (!caseId) caseId = (await db.query<{id:string}>("select id from agent_cases where organization_id=$1 and conversation_id=$2 and status in ('awaiting_human','awaiting_lead') order by created_at desc limit 1",[org,conversation])).rows[0]?.id;
  }
  if (caseId) await db.query("select public.fn_start_responsible_request($1,$2,'handoff')", [org, caseId]);
}

interface NotificationMatch { request_id: string; case_id: string; responsible_id: string; status: string; case_status: string; kind: string }

async function invalidReplyFeedback(db: Queryable, input: {org:string;session:string;responsible:Responsible;message:string}) {
  await db.query(`select public.fn_queue_responsible_delivery($1,n.request_id,$2,'receipt',n.target_conversation_id,n.target_contact_id,
    'Não consegui vincular sua resposta. Use Responder sobre o aviso recebido e envie a resposta ao cliente em texto ou áudio disponível.', $3)
    from agent_responsible_deliveries n join conversations v on v.organization_id=n.organization_id and v.id=n.target_conversation_id
    join agent_responsibles p on p.organization_id=n.organization_id and p.id=n.responsible_id
    join messages m on m.organization_id=n.organization_id and m.id=$3 and m.contact_id=n.target_contact_id
    where n.organization_id=$1 and n.responsible_id=$2 and n.purpose='notification' and v.channel_session_id=$4 and p.enabled
      and m.metadata->>'responsible_id'=$2::text
    order by n.created_at desc limit 1`, [input.org,input.responsible.id,input.message,input.session]);
}

/** A citação é chave de correlação, não autorização. Número+workspace+conexão também precisam casar. */
export async function acceptResponsibleReply(pool: pg.Pool, input: {
  org: string; session: string; responsible: Responsible; message: string; quoted: string | null;
}): Promise<"accepted" | "duplicate" | "already_answered" | "invalid_reply" | "unauthorized"> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const { rows } = await db.query<NotificationMatch>(`select r.id as request_id,r.case_id,r.status,r.kind,c.status as case_status,d.responsible_id
      from agent_responsible_requests r join agent_cases c on c.id=r.case_id and c.organization_id=r.organization_id
      join agent_responsible_deliveries d on d.request_id=r.id and d.organization_id=r.organization_id and d.purpose='notification'
      join messages m on m.id=coalesce(d.message_id,(select l.crm_message_id from send_ledger l
        where l.organization_id=d.organization_id and l.job_id=d.job_id and l.seq=1)) and m.organization_id=d.organization_id
      join agent_responsibles p on p.id=d.responsible_id and p.organization_id=d.organization_id
      join agent_responsible_settings s on s.agent_id=r.agent_id and s.organization_id=r.organization_id
      join agent_responsible_bindings b on b.organization_id=s.organization_id and b.agent_id=s.agent_id and b.responsible_id=p.id
      where r.organization_id=$1 and p.id=$2 and p.enabled and s.enabled and m.channel_session_id=$3
        and m.external_id is not null and (m.external_id=$4 or regexp_replace(m.external_id,'^.*_','')=$4)`, [input.org, input.responsible.id, input.session, input.quoted]);
    const match = rows[0];
    if (!match || rows.length !== 1) { await invalidReplyFeedback(db,input); await db.query("commit"); return "invalid_reply"; }
    // Mesma ordem de locks da resolução pela tela e do último CAS de envio:
    // caso → pedido. Inverter a ordem permite deadlock ao inserir o evento/FK.
    const currentCase = await db.query<{status:string}>("select status from agent_cases where organization_id=$1 and id=$2 for update", [input.org,match.case_id]);
    const currentRequest = await db.query<{status:string;kind:string}>("select status,kind from agent_responsible_requests where organization_id=$1 and id=$2 for update", [input.org,match.request_id]);
    if (!currentCase.rows[0] || !currentRequest.rows[0]) { await db.query("commit"); return "invalid_reply"; }
    Object.assign(match,{case_status:currentCase.rows[0].status,...currentRequest.rows[0]});
    const existing = await db.query("select id from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer' and source_message_id=$3", [input.org, match.request_id, input.message]);
    if (existing.rows.length) { await db.query("commit"); return "duplicate"; }
    const inbound = await db.query<{ type: string; body: string | null; conversation_id: string; contact_id: string; media_url:string|null;media_storage_path:string|null }>(`select type,body,conversation_id,contact_id,media_url,media_storage_path from messages
      where id=$1 and organization_id=$2 and channel_session_id=$3 and direction='inbound' and metadata->>'responsible_id'=$4`, [input.message, input.org, input.session, input.responsible.id]);
    const message = inbound.rows[0];
    if (!message || !["text", "audio"].includes(message.type) || (message.type === "text" && (!message.body?.trim() || message.body.length > 4000))
      || (message.type === "audio" && !message.media_url && !message.media_storage_path)) {
      await invalidReplyFeedback(db,input);
      await db.query("commit"); return "invalid_reply";
    }
    if (match.status !== "pending" || !["awaiting_human", "awaiting_lead", ...(match.kind === "handoff" ? ["escalated"] : [])].includes(match.case_status)) {
      await db.query("select public.fn_queue_responsible_delivery($1,$2,$3,'receipt',$4,$5,$6,$7)", [input.org, match.request_id, input.responsible.id, message.conversation_id, message.contact_id,
        "Este pedido já foi respondido ou encerrado. Sua mensagem não foi encaminhada ao cliente.", input.message]);
      await db.query("commit"); return "already_answered";
    }
    // O lock do pedido decide o primeiro responsável. Aceitação+outbox são atômicos.
    await db.query(`update agent_responsible_requests set status='answered',accepted_responsible_id=$3
      where organization_id=$1 and id=$2 and status='pending'`, [input.org, match.request_id, input.responsible.id]);
    await db.query(`select public.fn_queue_responsible_delivery($1,r.id,$3,'answer',r.conversation_id,r.contact_id,$4,$5)
      from agent_responsible_requests r where r.organization_id=$1 and r.id=$2`, [input.org, match.request_id, input.responsible.id, message.type === "text" ? message.body : null, input.message]);
    await db.query(`insert into agent_case_events(organization_id,case_id,kind,actor_kind,body,metadata)
      select $1,case_id,'agent_noted','system',$4,jsonb_build_object('responsible_id',$3::text,'message_id',$5::text,'delivery_status','pending','format',$6::text)
      from agent_responsible_requests where organization_id=$1 and id=$2`, [input.org, match.request_id, input.responsible.id, "Resposta do responsável recebida; aguardando confirmação da entrega ao cliente.", input.message, message.type]);
    await db.query("commit"); return "accepted";
  } catch (e) { await db.query("rollback"); throw e; } finally { db.release(); }
}
