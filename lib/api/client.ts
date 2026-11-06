import type { ZodSchema } from "zod";

import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type RequestOpts = {
  schema?: ZodSchema<unknown>;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Uma simulação cobrada não deve ser repetida automaticamente após timeout. */
  maxAttempts?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const MAX_IDEMPOTENT_WRITE_ATTEMPTS = 3;
// Estas rotas persistem a chave e conferem o mesmo ator/payload antes do replay.
// Ter apenas um header numa rota qualquer não oferece essa garantia.
const REPLAY_SAFE_POST_PATHS = new Set(["/api/v1/messages", "/api/v1/automation-rules"]);
const RETRYABLE_STATUSES = new Set([429, 503]);
const MUTATING_METHODS = new Set<HttpMethod>(["POST", "PATCH", "PUT", "DELETE"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  const base = 200 * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 100 - 50;
  return Math.max(0, Math.round(base + jitter));
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

function synthesizeCode(status: number): string {
  if (status >= 500) return "internal_error";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 400) return "unknown_error";
  return "unknown_error";
}

function combineSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
  const sources = signals.filter((s): s is AbortSignal => s !== undefined);
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(sources), dispose: () => {} };
  // Navegadores suportados pelo Next podem não ter a composição nativa.
  // O fallback não mantém listeners no sinal do chamador após cada tentativa.
  const controller = new AbortController();
  const subscriptions: Array<() => void> = [];
  for (const source of sources) {
    if (source.aborted) { controller.abort(source.reason); break; }
    const abort = () => controller.abort(source.reason);
    source.addEventListener('abort', abort, { once: true });
    subscriptions.push(() => source.removeEventListener('abort', abort));
  }
  return { signal: controller.signal, dispose: () => { for (const remove of subscriptions) remove(); } };
}

async function readBodySafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object" &&
    (value as { error: unknown }).error !== null
  );
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  const requestId = randomId();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Request-Id": requestId,
    ...(opts.headers ?? {}),
  };

  if (body !== undefined && body !== null) {
    headers["Content-Type"] ??= "application/json";
  }

  if (MUTATING_METHODS.has(method)) {
    headers["Idempotency-Key"] ??= opts.idempotencyKey ?? randomId();
  }

  const serializedBody = body === undefined || body === null ? undefined : JSON.stringify(body);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const replaySafeWrite = method === "POST" && REPLAY_SAFE_POST_PATHS.has(path) &&
    Boolean(opts.idempotencyKey?.trim()) && Boolean(headers["Idempotency-Key"]?.trim());
  const attemptLimit = replaySafeWrite ? MAX_IDEMPOTENT_WRITE_ATTEMPTS : MAX_ATTEMPTS;
  const requestedAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts! : attemptLimit;
  // Um timeout não prova que a escrita falhou. Mesmo com header de idempotência,
  // nem toda rota tem armazenamento dessa chave. Só repetimos as rotas auditadas
  // acima quando o chamador forneceu a chave estável da operação.
  const maxAttempts = MUTATING_METHODS.has(method) && !replaySafeWrite ? 1
    : Math.min(attemptLimit, Math.max(1, Math.trunc(requestedAttempts)));
  const deadline = performance.now() + timeoutMs;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutController = new AbortController();
    const remainingMs = Math.max(0, deadline - performance.now());
    if (remainingMs === 0) throw new DOMException('Request budget exhausted', 'TimeoutError');
    const timer = setTimeout(() => timeoutController.abort(), remainingMs);
    const { signal, dispose } = combineSignals([timeoutController.signal, opts.signal]);
    let responseReceived = false;

    try {
      const res = await fetch(path, {
        method,
        headers,
        body: serializedBody,
        credentials: "same-origin",
        signal,
      });
      responseReceived = true;

      const responseRequestId = res.headers.get("X-Request-Id") ?? requestId;

      if (res.ok) {
        const parsed = (await readBodySafe(res)) as T;
        if (opts.schema) {
          return opts.schema.parse(parsed) as T;
        }
        return parsed;
      }

      // Retry on 429/503
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts) {
        const retryAfter = parseRetryAfterSeconds(res.headers.get("Retry-After"));
        const delay = retryAfter !== null ? retryAfter * 1000 : backoffMs(attempt);
        if (delay < deadline - performance.now()) {
          // Libera a conexão e os bytes antes de outra tentativa. O relógio
          // total também cobre o body e a espera indicada pelo servidor.
          await res.body?.cancel();
          await sleep(delay, opts.signal);
          continue;
        }
      }

      // Non-retry error: parse and throw
      const errBody = await readBodySafe(res);
      if (isApiErrorBody(errBody)) {
        const e = errBody.error;
        throw new ApiError(
          res.status,
          e.code ?? synthesizeCode(res.status),
          e.details,
          e.request_id ?? responseRequestId,
          e.message,
        );
      }
      throw new ApiError(
        res.status,
        synthesizeCode(res.status),
        undefined,
        responseRequestId,
        typeof errBody === "string" && errBody.length > 0 ? errBody : `HTTP ${res.status}`,
      );
    } catch (err) {
      // ApiError thrown above for non-retryable: propagate immediately
      if (err instanceof ApiError) {
        throw err;
      }
      // Caller-provided signal aborted: propagate without retry
      if (opts.signal?.aborted) {
        throw err;
      }
      // A operação anterior pode continuar no servidor. Nunca repetir timeout,
      // cancelamento ou erro de schema. Uma falha de rede numa escrita com
      // deduplicação persistida pode recuperar o MESMO resultado, sem novo envio.
      if (replaySafeWrite && !responseReceived && err instanceof TypeError && !timeoutController.signal.aborted && attempt < maxAttempts) {
        const delay = backoffMs(attempt);
        if (delay < deadline - performance.now()) {
          await sleep(delay, opts.signal);
          continue;
        }
      }
      // As demais falhas de rede/timeout são devolvidas sem repetir.
      lastError = err;
      throw err;
    } finally {
      clearTimeout(timer);
      dispose();
    }
  }

  // Exhausted retries on retryable status: throw a synthetic ApiError
  throw (
    lastError ??
    new ApiError(503, "service_unavailable", undefined, requestId, "Max retries exhausted")
  );
}

export const apiClient = {
  get<T>(path: string, opts?: RequestOpts): Promise<T> {
    return request<T>("GET", path, undefined, opts);
  },
  post<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("POST", path, body, opts);
  },
  patch<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("PATCH", path, body, opts);
  },
  put<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("PUT", path, body, opts);
  },
  /**
   * `body` é OPCIONAL e novo: a rota de cancelar agendamento exige `{id, reason}`
   * no corpo do DELETE — o motivo do cancelamento é obrigatório de propósito
   * ("cancelado" sem motivo faz alguém ligar para o cliente perguntando o que
   * houve, ou pior, não ligar). Parâmetro opcional no fim mantém os chamadores
   * antigos byte a byte.
   */
  delete<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("DELETE", path, body, opts);
  },
};
