// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createServer, type Server } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { withReadRequest, MAX_ACTIVE_READS } from '@/lib/supabase/read-request';
import { serviceFetch, withServiceRequestBudget, MAX_SERVICE_PENDING_HEADERS } from '@/lib/supabase/service-fetch';
import { authServiceUnavailable } from '@/lib/auth/service-unavailable';

let server: Server | undefined;
beforeEach(() => { globalThis.__crmReadWork = undefined; vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; }
});
const request = (signal?: AbortSignal) => new NextRequest('http://synthetic.invalid/api/read', { signal });

describe('contenção de consultas da interface', () => {
  it('recusa excesso sem criar fila e libera os lugares depois de terminar', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const handler = vi.fn(async () => { await held; return new Response('ok'); });
    const read = withReadRequest('synthetic/read', handler);
    const pending = Array.from({ length: MAX_ACTIVE_READS }, () => read(request()));
    expect((await read(request())).status).toBe(503);
    expect(handler).toHaveBeenCalledTimes(MAX_ACTIVE_READS);
    release(); await Promise.all(pending);
    expect(globalThis.__crmReadWork?.active).toBe(0);
    expect((await read(request())).status).toBe(200);
  });

  it('uma falha não retém o lugar e não registra query, corpo ou credenciais', async () => {
    const read = withReadRequest('synthetic/read', async () => { throw new Error('private-body-and-token'); });
    await expect(read(request())).rejects.toThrow('private-body');
    expect(globalThis.__crmReadWork?.active).toBe(0);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('private-body');
  });

  it('aborta a leitura real quando a tela desiste', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_r, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const caller = new AbortController();
    const read = withReadRequest('synthetic/read', async () => serviceFetch({ fetch: fetcher })('https://synthetic.invalid/rest/v1/contacts'));
    const pending = read(request(caller.signal));
    caller.abort();
    expect((await pending).status).toBe(503);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(globalThis.__crmReadWork?.active).toBe(0);
  });

  it('Auth travado termina, mantém erro de infraestrutura e não vira credencial inválida', async () => {
    let calls = 0;
    server = createServer(() => { calls++; });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('missing address');
    const client = createClient(`http://127.0.0.1:${addr.port}`, 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: serviceFetch({ authTimeoutMs: 100 }) },
    });
    const started = performance.now();
    const result = await client.auth.getUser('synthetic-jwt');
    expect(authServiceUnavailable(result.error)).toBe(true);
    expect(calls).toBe(1);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('um orçamento interno não estende o prazo do chamador', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_r, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const started = performance.now();
    await expect(withServiceRequestBudget(100, () => withServiceRequestBudget(10_000,
      () => serviceFetch({ fetch: fetcher })('https://synthetic.invalid/rest/v1/contacts')))).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
  it('limita inclusive Auth antes de entrar no handler e não deixa chamadas em espera', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const fetcher = vi.fn<typeof fetch>(async () => { await held; return new Response('{}'); });
    const auth = serviceFetch({ fetch: fetcher, authTimeoutMs: 2_000 });
    const pending = Array.from({ length: MAX_SERVICE_PENDING_HEADERS }, () => auth('http://synthetic.invalid/auth/v1/user'));
    await expect(auth('http://synthetic.invalid/auth/v1/user')).rejects.toThrow('capacity exhausted');
    expect(fetcher).toHaveBeenCalledTimes(MAX_SERVICE_PENDING_HEADERS);
    release(); await Promise.all(pending);
    expect(globalThis.__crmServiceHeaders?.active).toBe(0);
  });
});
