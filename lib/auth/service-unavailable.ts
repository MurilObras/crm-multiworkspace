/** Falha de infraestrutura não é credencial inválida nem revogação de acesso. */
export function authServiceUnavailable(error: { name?: string; status?: number } | null | undefined): boolean {
  return error != null && (error.name === 'AuthRetryableFetchError' || (error.status ?? 0) >= 500);
}
