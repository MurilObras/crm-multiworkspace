import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ApiError } from '@/lib/api/types';
import { fail } from '@/lib/api/wrappers';
import { logger } from '@/lib/logger';
import { SESSION_DATABASE_TIMEOUT_MS, withServiceRequestBudget } from './service-fetch';

// Só contadores, nunca sessões/dados. globalThis também cobre módulos duplicados
// pelo empacotador. Não há fila em memória: excesso recebe indisponibilidade.
declare global {
  var __crmReadWork: { active: number; lastWarningAt: number } | undefined;
}
export const MAX_ACTIVE_READS = 64;

/** Para GETs de dados da interface; crons e transportes não passam por aqui. */
export function withReadRequest<Args extends unknown[]>(
  route: string, handler: (req: NextRequest, ...args: Args) => Promise<Response>,
): (req: NextRequest, ...args: Args) => Promise<Response> {
  return async (req, ...args) => {
    const requestId = randomUUID();
    const state = globalThis.__crmReadWork ??= { active: 0, lastWarningAt: 0 };
    if (state.active >= MAX_ACTIVE_READS) {
      if (Date.now() - state.lastWarningAt > 10_000) {
        state.lastWarningAt = Date.now();
        logger.warn('read_capacity_exceeded', { route, active_reads: state.active });
      }
      return fail('unavailable', 'Serviço temporariamente ocupado. Tente novamente.', 503, { requestId });
    }
    state.active++;
    const started = performance.now();
    let failed = false;
    try {
      const response = await withServiceRequestBudget(SESSION_DATABASE_TIMEOUT_MS,
        () => handler(req, ...args), { signal: req.signal });
      failed = response.status >= 500;
      return response;
    } catch (error) {
      failed = true;
      if (error instanceof ApiError) return fail(error.code, error.message, error.status, { requestId });
      if (req.signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
        return fail('unavailable', 'Não foi possível concluir a consulta. Tente novamente.', 503, { requestId });
      }
      throw error;
    } finally {
      state.active--;
      const elapsedMs = Math.round(performance.now() - started);
      if (failed || elapsedMs >= 2_000) {
        const memory = process.memoryUsage();
        logger.warn('read_request_finished', { route, elapsed_ms: elapsedMs, failed,
          active_reads: state.active, heap_used_bytes: memory.heapUsed, rss_bytes: memory.rss });
      }
    }
  };
}
