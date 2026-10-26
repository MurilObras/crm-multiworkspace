import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/lib/logger';

/** Leituras/RPCs pequenas não podem prender o canal durante minutos. Uploads
 * manuais continuam sem este teto; a cópia de mídia do worker tem teto próprio. */
export const SERVICE_DATABASE_TIMEOUT_MS = 20_000;
export const WORKER_STORAGE_TIMEOUT_MS = 60_000;
export const OUTBOUND_PREPARATION_BUDGET_MS = 60_000;

// Escopo por tentativa; requests de outros clientes/workspaces não compartilham
// relógio nem AbortController. Não interrompe tools por Promise.race.
const budgets = new AsyncLocalStorage<{ deadline: number | null }>();
export function withServiceRequestBudget<T>(milliseconds: number, run: () => Promise<T>): Promise<T> {
  return budgets.run({ deadline: performance.now() + milliseconds }, run);
}
export function resetServiceRequestBudget(milliseconds: number | null): void {
  const budget = budgets.getStore();
  if (budget) budget.deadline = milliseconds === null ? null : performance.now() + milliseconds;
}

export function serviceFetch(options: {
  storageTimeoutMs?: number;
  fetch?: typeof fetch;
} = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const database = url.pathname.startsWith('/rest/v1/');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    // GET da URL assinada transporta o arquivo inteiro, não é assinatura.
    const signing = method.toUpperCase() === 'POST' && url.pathname.startsWith('/storage/v1/object/sign/');
    const storage = url.pathname.startsWith('/storage/v1/');
    const limit = database || signing ? SERVICE_DATABASE_TIMEOUT_MS : storage ? options.storageTimeoutMs : undefined;
    if (limit === undefined) return (options.fetch ?? fetch)(input, init);
    const deadline = budgets.getStore()?.deadline;
    const timeoutMs = Math.max(0, Math.ceil(Math.min(limit, deadline == null ? limit : deadline - performance.now())));
    if (timeoutMs === 0) throw new DOMException('Service request budget exhausted', 'TimeoutError');
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const started = performance.now();
    // Nunca registrar URL, query, headers, corpo ou mensagem de erro da rede:
    // contêm filtros do cliente, caminhos privados e credenciais assinadas.
    const operation = database ? 'database' : signing ? 'storage_sign' : 'storage_transfer';
    try {
      const response = await (options.fetch ?? fetch)(input, { ...init, signal });
      const elapsedMs = Math.round(performance.now() - started);
      if (!response.ok || elapsedMs >= 2_000) logger.warn('service_request_headers', {
        operation, status: response.status, headers_ms: elapsedMs, timeout_ms: timeoutMs,
      });
      // O sinal permanece associado ao fetch real: inclui a leitura do BODY,
      // não só a chegada dos headers. Não usar Promise.race com escrita solta.
      return response;
    } catch (error) {
      logger.warn('service_request_failed', {
        operation, headers_ms: Math.round(performance.now() - started), timeout_ms: timeoutMs,
        reason: signal.aborted ? 'aborted' : 'network_error',
      });
      throw error;
    }
  };
}
