// @vitest-environment node
import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { crmEdgeConfigFromEnv } from '@/lib/agent-engine/edge/crm/mcp-client';
import { serviceFetch, SERVICE_DATABASE_TIMEOUT_MS, WORKER_STORAGE_TIMEOUT_MS,
  withServiceRequestBudget, resetServiceRequestBudget } from '@/lib/supabase/service-fetch';

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; }
});
async function receiver(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing receiver');
  return `http://127.0.0.1:${address.port}`;
}

describe('esperas HTTP do serviço', () => {
  it('interrompe headers travados e não reexecuta a requisição', async () => {
    let requests = 0;
    const url = await receiver((_req, _res) => { requests++; });
    const started = performance.now();
    await expect(withServiceRequestBudget(250,
      () => serviceFetch()(`${url}/rest/v1/conversations?secret=never-log`))).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(requests).toBe(1);
  });

  it('inclui body travado depois dos headers: a RPC não fica esperando indefinidamente', async () => {
    const url = await receiver((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); });
    const db = crmEdgeConfigFromEnv({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key' }).supabase;
    const result = await withServiceRequestBudget(250, async () => await db.from('messages').select('id'));
    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
  });

  it('não repete automaticamente GET 503: a fila é quem controla o retry', async () => {
    let requests = 0;
    const url = await receiver((_req, res) => { requests++; res.writeHead(503); res.end('{}'); });
    const db = crmEdgeConfigFromEnv({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key' }).supabase;
    expect((await db.from('messages').select('id')).error).not.toBeNull();
    expect(requests).toBe(1);
  });

  it('o orçamento esgotado impede OUTRA chamada, inclusive escrita; um novo escopo pode continuar', async () => {
    let requests = 0;
    const url = await receiver((_req, res) => { requests++; res.end('true'); });
    await withServiceRequestBudget(0, async () => {
      await expect(serviceFetch()(`${url}/rest/v1/rpc/test`, { method: 'POST' })).rejects.toThrow('budget exhausted');
    });
    expect(requests).toBe(0);
    await withServiceRequestBudget(1000, async () => {
      expect(await (await serviceFetch()(`${url}/rest/v1/rpc/test`, { method: 'POST' })).json()).toBe(true);
    });
    expect(requests).toBe(1);
  });

  it('orçamentos simultâneos não se contaminam; transporte possui janela própria', async () => {
    const url = await receiver((_req, res) => { setTimeout(() => res.end('true'), 60); });
    const [expired, healthy] = await Promise.all([
      withServiceRequestBudget(0, () => serviceFetch()(`${url}/rest/v1/messages`)).catch(() => 'expired'),
      withServiceRequestBudget(0, async () => {
        resetServiceRequestBudget(null);
        return (await serviceFetch()(`${url}/rest/v1/messages`)).json();
      }),
    ]);
    expect(expired).toBe('expired');
    expect(healthy).toBe(true);
  });

  it('preserva cancelamento do chamador, conteúdo e credencial, sem registrá-los', async () => {
    const logs = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const url = await receiver((_req, _res) => {});
    const controller = new AbortController();
    const result = serviceFetch()(`${url}/rest/v1/messages?phone=private`, {
      method: 'POST', headers: { authorization: 'private-token' }, body: 'private-body', signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private|token|phone/);
    expect(logs.mock.calls[0]?.[1]).toMatchObject({ operation: 'database', reason: 'aborted' });
  });

  it('assinatura curta, cópia do worker limitada e upload manual preservado', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const fake = vi.fn<typeof fetch>(async () => new Response('ok'));
    const admin = serviceFetch({ fetch: fake });
    await admin('https://synthetic.invalid/storage/v1/object/sign/bucket/file', { method: 'POST' });
    expect(timeouts).toHaveBeenLastCalledWith(SERVICE_DATABASE_TIMEOUT_MS);
    timeouts.mockClear();
    await admin('https://synthetic.invalid/storage/v1/object/bucket/file', { method: 'POST' });
    await admin('https://synthetic.invalid/storage/v1/object/sign/bucket/file?token=secret');
    expect(timeouts).not.toHaveBeenCalled();
    await serviceFetch({ fetch: fake, storageTimeoutMs: WORKER_STORAGE_TIMEOUT_MS })(
      'https://synthetic.invalid/storage/v1/object/bucket/file', { method: 'POST' });
    expect(timeouts).toHaveBeenLastCalledWith(WORKER_STORAGE_TIMEOUT_MS);
  });

  it('resposta saudável preserva o corpo e envia uma escrita só', async () => {
    let body = '';
    const url = await receiver((req, res) => {
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('[{"id":"synthetic"}]'); });
    });
    const db = createClient(url, 'synthetic-test-key', {
      auth: { persistSession: false }, db: { timeout: SERVICE_DATABASE_TIMEOUT_MS, retry: false },
      global: { fetch: serviceFetch() },
    });
    const result = await db.from('messages').insert({ body: 'conteúdo preservado' }).select();
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'synthetic' }]);
    expect(JSON.parse(body)).toEqual({ body: 'conteúdo preservado' });
  });
});
