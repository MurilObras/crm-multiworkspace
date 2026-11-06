// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ACTIVE_AUTH_REQUESTS } from '@/lib/auth/request-capacity';
import { proxy } from '../../proxy';

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser } }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

beforeEach(() => {
  globalThis.__crmAuthWork = undefined;
  getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
});

describe('proxy authentication capacity', () => {
  it.each(['/api/v1/conversations', '/app/inbox'])('fails closed with 503 for %s when authentication is saturated', async (path) => {
    globalThis.__crmAuthWork = { active: MAX_ACTIVE_AUTH_REQUESTS, lastWarningAt: 0 };
    const result = await proxy(new NextRequest(`http://localhost${path}`, {
      headers: { 'x-request-id': 'capacity-test' },
    }));
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: { code: 'unavailable' } });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-request-id')).toBe('capacity-test');
    expect(getUser).not.toHaveBeenCalled();
    expect(globalThis.__crmAuthWork.active).toBe(MAX_ACTIVE_AUTH_REQUESTS);
  });

  it('keeps public login available without authentication work', async () => {
    globalThis.__crmAuthWork = { active: MAX_ACTIVE_AUTH_REQUESTS, lastWarningAt: 0 };
    const result = await proxy(new NextRequest('http://localhost/login'));
    expect(result.status).toBe(200);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('preserves the unauthenticated API response when capacity is available', async () => {
    const result = await proxy(new NextRequest('http://localhost/api/v1/conversations'));
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(getUser).toHaveBeenCalledOnce();
    expect(globalThis.__crmAuthWork?.active).toBe(0);
  });
});
