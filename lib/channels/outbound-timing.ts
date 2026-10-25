import { logger } from '@/lib/logger';

export type OutboundSendPhase =
  | 'ledger' | 'prepare_media' | 'recipient' | 'persist_message'
  | 'prepare_transport' | 'preflight' | 'transport' | 'persist_result' | 'finalize' | 'reconcile';

/** Tempo de parede do sink separado do tempo do modelo. Somente identidades
 * internas: nunca conversa, telefone, URL ou conteúdo. */
export function outboundTiming(scope: { organization_id: string; job_id: string; seq: number }) {
  const started = performance.now();
  let since = started;
  let phase: OutboundSendPhase = 'ledger';
  const phases: Partial<Record<OutboundSendPhase, number>> = {};
  const record = () => {
    const now = performance.now();
    phases[phase] = (phases[phase] ?? 0) + Math.round(now - since);
    since = now;
  };
  return {
    phase(next: OutboundSendPhase) { record(); phase = next; },
    finish(outcome: string) {
      record();
      logger.info('outbound_attempt_timing', {
        ...scope, outcome, elapsed_ms: Math.round(performance.now() - started), phases_ms: phases,
      });
    },
  };
}
