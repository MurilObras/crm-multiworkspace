import type { Queryable } from "./queue";

/** Só junta rajadas da MESMA conversa/canal, ainda no debounce original.
 * Jobs retidos por limite ou falha precisam ser reavaliados, não absorver novos eventos.
 */
export async function coalesceInboundDebounce(
  db: Queryable,
  input: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    channelSessionId: string;
    messageId: string;
    eventId: string;
    debounceMs: number;
  },
): Promise<string | null> {
  if (input.debounceMs <= 0) return null;
  const { rows } = await db.query<{ id: string }>(
    `update job_queue set source_event_id = $6::text::uuid, payload = payload || jsonb_build_object(
       'inbound_message_id', $5::text, 'crm_event_id', $6::text)
     where id = (
       select id from job_queue
       where organization_id = $1 and contact_id = $2
         and kind = 'inbound_turn' and status = 'pending' and last_error is null
         and payload->>'conversation_id' = $3 and payload->>'channel_session_id' = $4
         and run_after > now() and run_after <= now() + ($7 * interval '1 millisecond')
       order by run_after, id limit 1 for update skip locked
     ) and organization_id = $1 and status = 'pending'
       and $5::text = (select id::text from messages
         where organization_id = $1 and conversation_id = $3::uuid and direction = 'inbound'
         order by coalesce(sent_at, created_at) desc, created_at desc, id desc limit 1)
     returning id`,
    [
      input.organizationId,
      input.contactId,
      input.conversationId,
      input.channelSessionId,
      input.messageId,
      input.eventId,
      input.debounceMs,
    ],
  );
  return rows[0]?.id ?? null;
}

/** A mudança de proteção apenas devolve respostas ao gate; não autoriza envio.
 * Não toca follow-ups, jobs em execução nem canais de outros workspaces.
 */
export async function recheckPacingHeldInbound(
  db: Queryable,
  organizationId: string,
  channelSessionId: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `update job_queue set run_after = now(), last_error = null
     where organization_id = $1 and payload->>'channel_session_id' = $2
       and kind = 'inbound_turn' and status = 'pending' and run_after > now()
       and (last_error like 'cap de envio (%) atingido%'
         or last_error like 'fora da janela anti-ban de envio%')`,
    [organizationId, channelSessionId],
  );
  return rowCount ?? 0;
}

/** Ancora a resposta na mensagem que originou o turno, inclusive após espera/LLM. */
export async function isCurrentInbound(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `select id from messages where organization_id = $1 and conversation_id = $2
       and direction = 'inbound'
     order by coalesce(sent_at, created_at) desc, created_at desc, id desc limit 1`,
    [organizationId, conversationId],
  );
  return rows[0]?.id === messageId;
}
