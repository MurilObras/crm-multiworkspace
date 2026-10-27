/** Falha técnica determinística: não é veto comercial e deve abrir aviso. */
export class CheckpointSchemaError extends Error {
  override readonly name = 'CheckpointSchemaError';
  readonly code = 'checkpoint_schema_invalid';
  readonly retryable = false;
  constructor(cause: unknown) {
    super('checkpoint_schema_invalid: o provedor recusou o formato da memória. Corrija a integração; não repita o atendimento.', { cause });
  }
}

export function isStructuredSchemaRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { statusCode?: number; status?: number; message?: unknown };
  return (value.statusCode ?? value.status) === 400 && typeof value.message === 'string'
    && /invalid schema|schema.*(?:not supported|unsupported|invalid)|additionalProperties.*required/i.test(value.message);
}
