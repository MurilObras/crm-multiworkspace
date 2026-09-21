import { z } from "zod";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";

export const HISTORY_STATES = {
  not_started: "Sem ação de mensagem", intake_refused: "Recusada na entrada",
  no_phone: "Compra aceita sem telefone", preparing: "Aguardando processamento",
  pending: "Aguardando processamento", sending: "Aguardando resposta do provedor",
  blocked: "Envio bloqueado", failed_before_send: "Falhou antes do envio",
  rejected: "Recusada pelo provedor", accepted: "Aceita pelo provedor",
  delivered: "Entrega confirmada", read: "Leitura confirmada",
  uncertain: "Resultado incerto", completed: "Ação concluída", failed: "Falha informada pelo provedor",
} as const;
export const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(128).default(""),
  status: z.enum(Object.keys(HISTORY_STATES) as [keyof typeof HISTORY_STATES, ...Array<keyof typeof HISTORY_STATES>]).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
}).refine(q => !q.from || !q.to || q.from <= q.to, "Período inválido.");
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export interface KiwifyHistoryRow {
  receipt_id: string; run_id: string | null; order_id: string; intake_status: string;
  lead_id: string | null; lead_title: string | null; contact_id: string | null;
  contact_name: string | null; current_phone: string | null; destination_phone: string | null;
  product_name: string | null; rule_name: string | null; action_type: string | null;
  action_index: number | null; channel: string | null; conversation_id: string | null;
  message_id: string | null; provider_id: string | null; attempted_at: string | null;
  created_at: string; updated_at: string; status: keyof typeof HISTORY_STATES; reason: string | null;
}

/** Chamado com papel authenticated/JWT da sessão: RLS continua sendo a autoridade
 * para os links. Toda junção também carrega o organization_id explicitamente.
 * Não seleciona payload, corpo de mensagem, erro livre ou segredo.
 */
export async function queryKiwifyHistory(db: Queryable, org: string, q: HistoryQuery) {
  const { rows } = await db.query<KiwifyHistoryRow>(`with history as (
    select k.id as receipt_id,r.id as run_id,k.order_id,k.status as intake_status,
      l.id as lead_id,case when c.is_anonymized then null else l.title end as lead_title,
      c.id as contact_id,case when not c.is_anonymized then coalesce(c.display_name,c.name) end as contact_name,
      case when not c.is_anonymized then c.phone_number end as current_phone,
      case when not c.is_anonymized then m.metadata->>'automation_destination_phone' end as destination_phone,
      p.nome as product_name,a.name as rule_name,r.actions_result->0->>'type' as action_type,r.action_index,
      s.provider as channel,v.id as conversation_id,m.id as message_id,
      case when not c.is_anonymized then m.external_id end as provider_id,
      case when m.metadata->'outbound_attempt'->>'phase' in ('started','uncertain','rejected') then m.sent_at end as attempted_at,
      k.created_at,greatest(k.created_at,r.execution_updated_at,m.updated_at) as updated_at,
      case when r.id is null then case when k.status='accepted_no_phone' then 'no_phone'
        when k.status not in ('accepted','accepted_no_phone') then 'intake_refused' else 'not_started' end
      when m.status in ('delivered','read') then m.status
      when m.status='sent' and m.external_id is not null then 'accepted'
      when m.status='failed' and m.external_id is not null then 'failed'
      when m.metadata->'outbound_attempt'->>'phase'='uncertain' then 'uncertain'
      when m.status='failed' and m.metadata->'outbound_attempt'->>'phase'='started' then 'uncertain'
      when m.metadata->'outbound_attempt'->>'phase'='rejected' then 'rejected'
      when en.id is not null and m.status='failed' then 'failed_before_send'
      when en.id is not null and m.status in ('queued','sending') then 'pending'
      when r.execution_state is null and r.status='adiado' then 'pending'
      else r.execution_state end as status,
      coalesce(m.error_code,r.actions_result->0->'detail'->>'reason',k.reason) as reason
    from kiwify_receipts k
    left join crm_leads l on l.id=k.lead_id and l.organization_id=k.organization_id
    left join catalog_products p on p.id::text=l.custom_fields->>'product_id' and p.organization_id=k.organization_id
    left join automation_rule_runs r on r.event_id=k.event_id and r.organization_id=k.organization_id
      and (r.action_index is not null or (r.execution_state is null and r.status='adiado'
        and not exists(select 1 from automation_rule_runs done where done.event_id=k.event_id
          and done.organization_id=k.organization_id and done.action_index is not null)
        and r.id=(select waiting.id from automation_rule_runs waiting where waiting.event_id=k.event_id
          and waiting.organization_id=k.organization_id and waiting.status='adiado'
          order by waiting.created_at desc,waiting.id limit 1)))
    left join automation_rules a on a.id=r.rule_id and a.organization_id=k.organization_id
    left join followup_enrollments en on en.automation_run_id=r.id and en.organization_id=k.organization_id
    left join lateral (
      select direct.* from messages direct where direct.id=r.message_id and direct.organization_id=k.organization_id
      union all
      select indirect.* from messages indirect
      join send_ledger sl on sl.crm_message_id=indirect.id and sl.organization_id=k.organization_id
      join job_queue j on j.id=sl.job_id and j.organization_id=k.organization_id
      where en.id is not null and j.payload->>'followup_enrollment_id'=en.id::text
        and indirect.organization_id=k.organization_id
    ) m on true
    left join contacts c on c.id=coalesce(m.contact_id,l.contact_id) and c.organization_id=k.organization_id
    left join lateral (
      -- Sem mensagem, só há atalho quando existe UMA conversa visível do
      -- contato exato. Nunca escolhe por telefone, nome ou proximidade temporal.
      select case when count(*)=1 then min(existing.id::text)::uuid end as id
      from conversations existing where existing.organization_id=k.organization_id
        and existing.contact_id=c.id and not existing.is_group
        and (m.conversation_id is null or existing.id=m.conversation_id)
    ) v on true
    left join channel_sessions s on s.id=m.channel_session_id and s.organization_id=k.organization_id
    where k.organization_id=$1 and ($2::date is null or k.created_at >= ($2::date::timestamp at time zone 'UTC'))
      and ($3::date is null or k.created_at < (($3::date+interval '1 day') at time zone 'UTC'))
  ) select * from history where ($4::text is null or status=$4 or ($4='pending' and status='preparing'))
    and ($5='' or strpos(lower(order_id),lower($5))>0 or strpos(lower(coalesce(contact_name,'')),lower($5))>0
      or strpos(coalesce(current_phone,''),$5)>0 or strpos(coalesce(destination_phone,''),$5)>0)
    order by created_at desc,receipt_id,action_index nulls first,message_id nulls first
    limit $6 offset $7`,[org,q.from ?? null,q.to ?? null,q.status ?? null,q.search,q.limit+1,(q.page-1)*q.limit]);
  return { rows: rows.slice(0,q.limit), has_more: rows.length>q.limit };
}

export function historyExplanation(row: Pick<KiwifyHistoryRow,"status" | "reason">): string {
  if (row.status === "uncertain") return "Confira a conversa antes de enviar manualmente: o cliente pode já ter recebido.";
  if (row.status === "failed_before_send" && row.reason === "awaiting_processing") return "O processamento foi interrompido antes do envio.";
  if (row.reason === "consent_declined") return "O contato recusou o consentimento. Envio bloqueado.";
  const reasons: Record<string,string> = {
    contact_blocked: "Contato bloqueado.", contact_anonymized: "Contato anonimizado.",
    no_phone: "Não há telefone disponível.", no_contact: "Não há contato vinculado.",
    missing_config: "A configuração da ação está incompleta.",
    invalid_config: "A configuração da ação é inválida ou incompleta.",
    recipient_changed: "O destinatário mudou antes do envio.",
    messaging_window_closed: "A janela do canal exige um template aprovado.",
    awaiting_processing: "A ação aguarda processamento.",
    template_not_found: "O template não está disponível neste canal.",
    template_not_approved: "O template não está aprovado.",
    template_missing_values: "Faltam parâmetros obrigatórios do template.",
    template_invalid_values: "Os parâmetros não correspondem ao template.",
    template_definition_unavailable: "Não foi possível validar o template.",
    template_not_supported: "Este canal não aceita esse tipo de template.",
    channel_unavailable: "O canal não está disponível para envio.",
    outbound_session_unavailable: "O canal não está disponível para envio.",
    channel_session_not_working: "O número escolhido não está conectado no momento.",
    template_lookup_failed: "Não foi possível validar o template.",
    meta_session_credentials_missing: "A configuração do canal está incompleta.",
    meta_credentials_lookup_failed: "Não foi possível validar a configuração do canal.",
    daily_limit: "O limite diário do canal foi atingido.",
  };
  return reasons[row.reason ?? ""] ?? fraseDaFalhaDeCanal(row.reason)
    ?? (row.status === "not_started" ? "Nenhuma tentativa de mensagem registrada." : HISTORY_STATES[row.status]);
}
