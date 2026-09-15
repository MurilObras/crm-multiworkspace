export interface RecoveryMessage {
  id: string;
  status: string;
  external_id: string | null;
  error_code?: string | null;
  metadata: Record<string, unknown> | null;
}

export type RecoveryDecision = 'confirmed' | 'retry_safe' | 'uncertain' | 'terminal';

/** Uma política para inline, worker e recuperação de sending pelo cron.
 * A fase é durável em messages.metadata.outbound_attempt, não inferida de timeout.
 * Sem message ainda não pode ter havido transporte pelo sink. Retoma a MESMA key.
 * Após started, inclusive o intervalo entre marcador e HTTP, só confirmação do
 * provedor ou rejeição explícita removem a incerteza. */
export function decideOutboundRecovery(ledgerStatus: string, message: RecoveryMessage | null): RecoveryDecision {
  if (!['requested','queued','accepted','failed','vetoed'].includes(ledgerStatus)) return 'uncertain';
  if (!message) return ledgerStatus === 'requested' ? 'retry_safe' : 'uncertain';
  if (['sent', 'delivered', 'read'].includes(message.status) && message.external_id) return 'confirmed';
  const attempt = message.metadata?.outbound_attempt as { phase?: string; retryable?: boolean } | undefined;
  if (message.status === 'sending' || attempt?.phase === 'started' || attempt?.phase === 'uncertain') return 'uncertain';
  if (ledgerStatus === 'vetoed') return 'terminal';
  if (attempt?.phase === 'rejected') return attempt.retryable === true ? 'retry_safe' : 'terminal';
  if (attempt?.phase === 'prepared' && ['queued', 'failed'].includes(message.status)) return 'retry_safe';
  // Legado sem snapshot/fase não fornece prova suficiente para refazer o envio.
  return 'uncertain';
}
