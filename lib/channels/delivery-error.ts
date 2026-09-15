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
