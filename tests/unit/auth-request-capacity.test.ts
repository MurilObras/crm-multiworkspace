// @vitest-environment node
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authServiceUnavailable } from '@/lib/auth/service-unavailable';
import { MAX_ACTIVE_AUTH_REQUESTS, withAuthRequestCapacity } from '@/lib/auth/request-capacity';
import { serviceFetch } from '@/lib/supabase/service-fetch';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

let server: Server | undefined;
const user = { id: 'ffffffff-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated' };

async function startAuth(handler: (response: ServerResponse) => void, timeoutMs = 10_000) {
  server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local server address');
  return createClient(`http://127.0.0.1:${address.port}`, 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: serviceFetch({ authTimeoutMs: timeoutMs }) },
  });
}

beforeEach(() => {
  globalThis.__crmAuthWork = undefined;
  globalThis.__crmServiceHeaders = undefined;
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
});

describe('authentication capacity covers the complete SDK operation', () => {
  it('keeps the slot after headers, rejects overflow without transport, and recovers after body consumption', async () => {
    const bodies = new Set<ServerResponse>();
    let calls = 0;
    let releaseImmediately = false;
    const client = await startAuth((response) => {
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      bodies.add(response);
      if (releaseImmediately) response.end(JSON.stringify(user));
    });
    const pending = Array.from({ length: MAX_ACTIVE_AUTH_REQUESTS }, () =>
      withAuthRequestCapacity(() => client.auth.getUser('synthetic-jwt')));

    try {
      await vi.waitFor(() => {
        expect(calls).toBe(MAX_ACTIVE_AUTH_REQUESTS);
        expect(globalThis.__crmServiceHeaders?.active).toBe(0);
      }, { timeout: 5_000 });
      expect(globalThis.__crmAuthWork?.active).toBe(MAX_ACTIVE_AUTH_REQUESTS);
      const overflow = vi.fn(() => client.auth.getUser('synthetic-jwt'));
      expect(await withAuthRequestCapacity(overflow)).toEqual({ accepted: false });
      expect(overflow).not.toHaveBeenCalled();
      expect(calls).toBe(MAX_ACTIVE_AUTH_REQUESTS);
    } finally {
      for (const response of bodies) response.end(JSON.stringify(user));
      await Promise.all(pending);
    }

    expect(globalThis.__crmAuthWork?.active).toBe(0);
    releaseImmediately = true;
    const recovered = await withAuthRequestCapacity(() => client.auth.getUser('synthetic-jwt'));
    expect(recovered).toMatchObject({ accepted: true, result: { error: null, data: { user: { id: user.id } } } });
    expect(calls).toBe(MAX_ACTIVE_AUTH_REQUESTS + 1);
    expect(globalThis.__crmAuthWork?.active).toBe(0);
  }, 20_000);

  it('releases the slot on a real body timeout and preserves infrastructure-error classification', async () => {
    const client = await startAuth((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
    }, 100);
    const result = await withAuthRequestCapacity(() => client.auth.getUser('synthetic-jwt'));
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('Unexpected capacity rejection');
    expect(result.result.error?.name).toBe('AuthRetryableFetchError');
    expect(authServiceUnavailable(result.result.error)).toBe(true);
    expect(globalThis.__crmAuthWork?.active).toBe(0);
  });

  it('releases the slot if the operation throws instead of returning a result', async () => {
    await expect(withAuthRequestCapacity(async () => { throw new Error('operation failed'); })).rejects.toThrow('operation failed');
    expect(globalThis.__crmAuthWork?.active).toBe(0);
    expect(await withAuthRequestCapacity(async () => null)).toEqual({ accepted: true, result: null });
  });
});
