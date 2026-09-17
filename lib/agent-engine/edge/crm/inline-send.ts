import type { SupabaseClient } from '@supabase/supabase-js';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';
import type { Queryable } from '../../queue/queue';
import { sendTurnMessage } from './send-message';

/** Só adapta o chamador inline: política, ledger e transporte são os do worker. */
export async function sendInlineTurnMessage(
  pool: Queryable, db: SupabaseClient, ctx: HandlerCtx, jobId: string, contactId: string,
  workerId: string, prepare: () => Promise<SendMessageInput>,
) {
  const result = await sendTurnMessage(pool, { supabase: db }, {
    tenantId: ctx.organization_id, leadId: contactId, jobId, seq: 1, workerId,
    conversationId: '', body: '',
  }, { actor: ctx.actor, prepare });
  return {
    id: 'crmMessageId' in result ? result.crmMessageId : null,
    status: result.kind === 'already_sent' ? 'sent' : result.kind,
    error_code: result.kind === 'failed' ? 'outbound_not_confirmed' : null,
  };
}
