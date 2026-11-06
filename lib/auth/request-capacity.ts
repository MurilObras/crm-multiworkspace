import { logger } from '@/lib/logger';

export const MAX_ACTIVE_AUTH_REQUESTS = 128;

declare global {
  var __crmAuthWork: { active: number; lastWarningAt: number } | undefined;
}

type AuthRequestResult<T> = { accepted: false } | { accepted: true; result: T };

/** Contabiliza a operação inteira, inclusive a leitura do corpo pelo SDK.
 * Cada runtime mantém seu próprio limite: o proxy pode executar separado do
 * renderizador. Só há contadores, nunca sessão, usuário ou fila em memória. */
export async function withAuthRequestCapacity<T>(run: () => Promise<T>): Promise<AuthRequestResult<T>> {
  const state = globalThis.__crmAuthWork ??= { active: 0, lastWarningAt: 0 };
  if (state.active >= MAX_ACTIVE_AUTH_REQUESTS) {
    if (Date.now() - state.lastWarningAt > 10_000) {
      state.lastWarningAt = Date.now();
      logger.warn('auth_capacity_exceeded', { active_auth_requests: state.active });
    }
    return { accepted: false };
  }
  state.active++;
  try { return { accepted: true, result: await run() }; }
  finally { state.active--; }
}
