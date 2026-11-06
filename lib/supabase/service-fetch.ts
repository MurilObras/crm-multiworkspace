import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/lib/logger';

/** Leituras/RPCs pequenas não podem prender o canal durante minutos. Uploads
 * manuais continuam sem este teto; a cópia de mídia do worker tem teto próprio. */
export const SERVICE_DATABASE_TIMEOUT_MS = 20_000;
export const SESSION_DATABASE_TIMEOUT_MS = 8_000;
export const SESSION_AUTH_TIMEOUT_MS = 5_000;
export const WORKER_STORAGE_TIMEOUT_MS = 60_000;
export const OUTBOUND_PREPARATION_BUDGET_MS = 60_000;
export const MAX_SERVICE_PENDING_HEADERS = 128;
declare global {
  var __crmServiceHeaders: { active: number; lastWarningAt: number } | undefined;
}

// Escopo por tentativa; requests de outros clientes/workspaces não compartilham
// relógio nem AbortController. Não interrompe tools por Promise.race.
const budgets = new AsyncLocalStorage<{ deadline: number | null; signal?: AbortSignal }>();
export function withServiceRequestBudget<T>(
  milliseconds: number, run: () => Promise<T>, options: { signal?: AbortSignal } = {},
): Promise<T> {
  const parent = budgets.getStore();
  const deadline = Math.min(parent?.deadline ?? Infinity, performance.now() + milliseconds);
  const signals = [parent?.signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
  return budgets.run({ deadline, signal: signals.length ? AbortSignal.any(signals) : undefined }, run);
}
export function resetServiceRequestBudget(milliseconds: number | null): void {
  const budget = budgets.getStore();
  if (budget) budget.deadline = milliseconds === null ? null : performance.now() + milliseconds;
}
export function serviceRequestBudgetRemaining(): number {
  const deadline = budgets.getStore()?.deadline;
  return deadline == null ? Infinity : Math.max(0, deadline - performance.now());
}

export function serviceFetch(options: {
  storageTimeoutMs?: number;
  databaseTimeoutMs?: number;
  authTimeoutMs?: number;
  fetch?: typeof fetch;
} = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const database = url.pathname.startsWith('/rest/v1/');
    const auth = url.pathname.startsWith('/auth/v1/');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    // GET da URL assinada transporta o arquivo inteiro, não é assinatura.
    const signing = method.toUpperCase() === 'POST' && url.pathname.startsWith('/storage/v1/object/sign/');
    const storage = url.pathname.startsWith('/storage/v1/');
    const limit = database ? options.databaseTimeoutMs ?? SERVICE_DATABASE_TIMEOUT_MS
      : signing ? SERVICE_DATABASE_TIMEOUT_MS
      : auth ? options.authTimeoutMs : storage ? options.storageTimeoutMs : undefined;
    if (limit === undefined) return (options.fetch ?? fetch)(input, init);
    const scope = budgets.getStore();
    const deadline = scope?.deadline;
    const timeoutMs = Math.max(0, Math.ceil(Math.min(limit, deadline == null ? limit : deadline - performance.now())));
    if (timeoutMs === 0) throw new DOMException('Service request budget exhausted', 'TimeoutError');
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // Desistência da tela cancela leituras. Escrita pode já ter confirmado no
    // banco: seu resultado continua sendo reconciliado pelo dono da operação.
    const readSignal = ['GET', 'HEAD'].includes(method.toUpperCase()) ? scope?.signal : undefined;
    const signals = [callerSignal, readSignal, AbortSignal.timeout(timeoutMs)]
      .filter((s): s is AbortSignal => s != null);
    const signal = AbortSignal.any(signals);
    const started = performance.now();
    // Nunca registrar URL, query, headers, corpo ou mensagem de erro da rede:
    // contêm filtros do cliente, caminhos privados e credenciais assinadas.
    const operation = database ? 'database' : auth ? 'auth' : signing ? 'storage_sign' : 'storage_transfer';
    // Protege também o Auth do proxy, que ocorre antes do guard dos GETs.
    // Nenhuma fila de Promises: recusa ANTES de iniciar nova operação remota.
    const headers = globalThis.__crmServiceHeaders ??= { active: 0, lastWarningAt: 0 };
    if (headers.active >= MAX_SERVICE_PENDING_HEADERS) {
      if (Date.now() - headers.lastWarningAt > 10_000) {
        headers.lastWarningAt = Date.now();
        logger.warn('service_capacity_exceeded', { operation, pending_headers: headers.active });
      }
      throw new DOMException('Service request capacity exhausted', 'TimeoutError');
    }
    headers.active++;
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
    } finally {
      headers.active--;
    }
  };
}
