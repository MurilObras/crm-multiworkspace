import { OutboundLeaseLostError } from '@/lib/channels/delivery-error';
import type { Queryable } from '../../queue/queue';

/** O turno obsoleto pode estar retomando envios retidos por sessão offline.
 * Fecha somente intenções deste job com prova de que a rede não começou.
 * O lock do owner e os predicados na escrita preservam outro worker, ACKs,
 * transporte iniciado/incerto e mensagens de outras conversas/workspaces.
 * Mensagem e ledger mudam no mesmo statement, antes de liberar a lane. */
export async function discardSupersededOutbound(
  db: Queryable,
  input: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    jobId: string;
    workerId: string;
  },
): Promise<void> {
  return discardPreparedOutbound(db, input, { code: 'inbound_superseded' });
}

/** Mesmo CAS para retirar um plano de áudio, sem descartar as respostas normais. */
export async function discardPreparedOutbound(
  db: Queryable,
  input: { organizationId: string; contactId: string; conversationId: string; jobId: string; workerId: string },
  reason: { code: 'inbound_superseded' | 'required_audio_no_longer_eligible'; maxSequence?: number },
): Promise<void> {
  const { rows } = await db.query<{ owned: boolean }>(
    `with owner as materialized (
       select id from job_queue
       where id=$1 and organization_id=$2 and contact_id=$3
         and kind='inbound_turn' and status='running' and locked_by=$4
         and payload->>'conversation_id'=$5::text
       for update
     ), discarded as (
       update messages m set status='failed', error_code=$6,
         error_message=$7,
         metadata=coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object(
           'outbound_attempt',(m.metadata->'outbound_attempt') ||
             '{"phase":"rejected","retryable":false}'::jsonb)
       where m.organization_id=$2 and m.contact_id=$3 and m.conversation_id=$5::text::uuid
         and m.direction='outbound' and m.status in ('queued','failed')
         and m.external_id is null and m.metadata->'outbound_attempt'->>'phase'='prepared'
         and exists(select 1 from owner)
         and exists(select 1 from send_ledger l
           where l.id::text=m.metadata->>'idempotency_key'
             and l.organization_id=$2 and l.contact_id=$3 and l.job_id=$1
             and ($8::integer is null or l.seq<=$8)
             and l.status in ('requested','queued','failed')
             and (l.crm_message_id is null or l.crm_message_id=m.id))
       returning m.id,m.metadata->>'idempotency_key' as intent_id
     ), vetoed as (
       update send_ledger l set status='vetoed', last_error=$6,
         crm_message_id=coalesce(l.crm_message_id,
           (select d.id from discarded d where d.intent_id=l.id::text)),
         updated_at=now()
       where l.organization_id=$2 and l.contact_id=$3 and l.job_id=$1
         and ($8::integer is null or l.seq<=$8)
         and l.status in ('requested','queued','failed') and exists(select 1 from owner)
         and (exists(select 1 from discarded d where d.intent_id=l.id::text)
           or (l.status='requested' and l.crm_message_id is null and not exists(
             select 1 from messages m where m.organization_id=$2
               and m.metadata->>'idempotency_key'=l.id::text)))
       returning l.id
     ) select exists(select 1 from owner) as owned`,
    [input.jobId, input.organizationId, input.contactId, input.workerId, input.conversationId, reason.code,
      reason.code === 'inbound_superseded' ? 'Resposta dispensada porque chegou uma nova mensagem.'
        : 'Recepção com áudio dispensada porque a configuração ou a etapa mudou.', reason.maxSequence ?? null],
  );
  if (!rows[0]?.owned) throw new OutboundLeaseLostError();
}
