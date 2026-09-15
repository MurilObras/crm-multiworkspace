import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';

type Ledger = { id: string; status: string; crm_message_id: string | null };
type Receipt = { id: string | null; status: string; error_code: string | null };

/** Acesso Supabase ao MESMO send_ledger do agent-engine. Um job inline envia uma
 * única bolha (seq=1). Reserva por unique(job_id,seq), antes do transporte, e
 * reconcilia a mensagem pela chave canônica mesmo se a gravação do ledger falhar.
 * Tentativa existente nunca é rotacionada aqui: incerteza não autoriza reenvio. */
export async function sendInlineTurnMessage(
  db: SupabaseClient, ctx: HandlerCtx, jobId: string, contactId: string,
  prepare: () => Promise<SendMessageInput>,
): Promise<Receipt> {
  const org = ctx.organization_id;
  const loadLedger = async () => {
    const { data, error } = await db.from('send_ledger').select('id, status, crm_message_id')
      .eq('organization_id', org).eq('contact_id', contactId).eq('job_id', jobId).eq('seq', 1).maybeSingle();
    if (error) throw new Error('inline_ledger_lookup_failed');
    return data as Ledger | null;
  };
  const reconcile = async (ledger: Ledger): Promise<Receipt> => {
    let q = db.from('messages').select('id, status, error_code')
      .eq('organization_id', org).eq('contact_id', contactId).eq('direction', 'outbound')
      .eq('metadata->>idempotency_key', ledger.id);
    if (ledger.crm_message_id) q = q.eq('id', ledger.crm_message_id);
    const { data: message, error } = await q.maybeSingle();
    if (error) throw new Error('inline_message_lookup_failed');
    // Outra execução pode ter reservado e ainda não inserido a mensagem. Não
    // enviar no escuro; uma nova consulta resolverá quando a linha estiver visível.
    if (!message) return { id: null, status: 'queued', error_code: 'inline_attempt_unresolved' };
    const status = ['sent', 'delivered', 'read'].includes(message.status) ? 'accepted'
      : message.status === 'failed' ? 'failed' : 'queued';
    const { error: saveError } = await db.from('send_ledger').update({
      status, crm_message_id: message.id, last_error: message.error_code ?? null,
    }).eq('id', ledger.id).eq('organization_id', org).eq('job_id', jobId).eq('seq', 1);
    if (saveError) throw new Error('inline_ledger_update_failed');
    return message as Receipt;
  };

  const previous = await loadLedger();
  if (previous) return reconcile(previous);

  // Preparação pode falhar sem reservar tentativa: nenhuma mensagem saiu ainda.
  const input = await prepare();
  const { data, error } = await db.from('send_ledger').insert({
    organization_id: org, contact_id: contactId, job_id: jobId, seq: 1,
    body_hash: createHash('sha256').update(input.body ?? '').digest('hex'),
  }).select('id, status, crm_message_id').single();
  if (error?.code === '23505') {
    const winner = await loadLedger();
    if (!winner) throw new Error('inline_ledger_conflict');
    return reconcile(winner);
  }
  if (error || !data) throw new Error('inline_ledger_insert_failed');
  const ledger = data as Ledger;
  await sendMessageHandler(db, { ...ctx, requestId: ledger.id }, {
    ...input, metadata: { ...input.metadata, idempotency_key: ledger.id },
  }, { beforeSend: async (message) => {
    const { data: linked, error: linkError } = await db.from('send_ledger')
      .update({ crm_message_id: message.id }).eq('organization_id', org).eq('id', ledger.id)
      .eq('job_id', jobId).eq('seq', 1).is('crm_message_id', null).select('id').maybeSingle();
    if (linkError || !linked) throw new Error('inline_message_link_failed');
    ledger.crm_message_id = message.id;
  }, beforeTransport: async (message) => {
    const { data: sending, error: sendingError } = await db.from('messages').update({ status: 'sending' })
      .eq('organization_id', org).eq('id', message.id).eq('status', 'queued').select('id').maybeSingle();
    if (sendingError || !sending) throw new Error('inline_transport_claim_failed');
  } });
  return reconcile(ledger);
}
