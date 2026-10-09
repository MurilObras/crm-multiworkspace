/** Indisponibilidade temporária: aguardar nova consulta, nunca usar snapshot antigo. */
export class SubscriptionLookupUnavailableError extends Error {
  constructor() {
    super("subscription_lookup_unavailable");
    this.name = "SubscriptionLookupUnavailableError";
  }
}
