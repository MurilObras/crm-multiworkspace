import type { Message } from '@/lib/types/messaging';

/** Escrita controlada: metadata da tentativa é mesclado a partir da linha atual,
 * nunca restaurado de uma fotografia do executor. */
export interface OutboundAttemptWrite {
  expectedPhase: string | null;
  phase: 'prepared' | 'started' | 'rejected' | 'uncertain';
  patch: Partial<Pick<Message, 'status' | 'error_code' | 'error_message' | 'external_id' | 'ack'>> & {
    template_name?: string;
    template_language?: string;
  };
  queuedReason?: string;
  retryable?: boolean;
}

/** Só usar quando há prova de rejeição: timeout/erro de rede não são prova. */
export class DeliveryRejectedError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
    this.name = 'DeliveryRejectedError';
  }
}

/** Perda de propriedade não é falha da mensagem de outro executor. */
export class OutboundLeaseLostError extends Error {
  constructor() { super('outbound_lease_lost'); this.name = 'OutboundLeaseLostError'; }
}
