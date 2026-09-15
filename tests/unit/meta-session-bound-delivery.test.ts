import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import { getAdapter } from '@/lib/channels';
import { decideOutboundRecovery } from '@/lib/agent-engine/edge/crm/outbound-recovery';

let activeDb: SupabaseClient;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => activeDb }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let decryptFails = false;
function database(): SupabaseClient {
  return {
    async rpc(name: string, args: Row) {
      if (name === 'fn_decrypt_oauth') {
        const tokens: Record<string, string> = { '\\xaa': 'token-A', '\\xbb': 'token-B' };
        return { data: decryptFails ? null : tokens[String(args.ciphertext)], error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let mode = 'read'; let patch: Row = {}; let columns = '';
      const execute = () => {
        const rows = tables[table];
        if (!rows) throw new Error(`unexpected_table:${table}`);
        if (mode === 'insert') {
          const row = { id: `msg-${rows.length}`, error_code: null, error_message: null, ...patch };
          rows.push(row); return { data: [{ ...row }], error: null };
        }
        const found = rows.filter((r) => filters.every((p) => p(r)));
        if (mode === 'update') found.forEach((r) => Object.assign(r, patch));
        if (mode === 'delete') tables[table] = rows.filter((r) => !found.includes(r));
        const data = found.map((r) => {
          if (table === 'conversations') return { ...r,
            contacts: tables.contacts!.find((c) => c.id === r.contact_id),
            channel_sessions: tables.channel_sessions!.find((s) => s.id === r.channel_session_id) };
          // Honra SELECT: omitir parameter_format tem de quebrar o teste NAMED.
          return Object.fromEntries(Object.entries(r).filter(([k]) => columns === '*' || columns.split(',').map((s) => s.trim()).includes(k)));
        });
        return { data, error: null };
      };
      const q = {
        select(c: string) { columns = c; return q; },
        eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
        is(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
        neq(k: string, v: unknown) { filters.push((r) => r[k] !== v); return q; },
        in(k: string, values: unknown[]) { filters.push((r) => values.includes(r[k])); return q; },
        insert(p: Row) { mode = 'insert'; patch = p; return q; },
        update(p: Row) { mode = 'update'; patch = p; return q; },
        delete() { mode = 'delete'; return q; },
        async maybeSingle() { const r = execute(); return r.data.length > 1
          ? { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
          : { data: r.data[0] ?? null, error: null }; },
        async single() { return q.maybeSingle(); },
        async then(resolve: (v: ReturnType<typeof execute>) => unknown) { return resolve(execute()); },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

// Receiver HTTP real; só o destino de rede é redirecionado para localhost.
// Handler, resolução de credencial, decrypt RPC e montagem de components são reais.
let server: Server; let receiver: string;
const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
const urls: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.${requests.length}` }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiver = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  decryptFails = false; requests.length = 0; urls.length = 0;
  tables = {
    channel_sessions: ['A', 'B'].map((id) => ({ id, organization_id: 'org', provider: 'meta_cloud', status: 'WORKING',
      archived_at: null, meta_phone_number_id: `phone-${id}`, meta_token_encrypted: id === 'A' ? '\\xaa' : '\\xbb' })),
    contacts: [{ id: 'contact', organization_id: 'org', phone_number: '+5511000000000', is_blocked: false }],
    conversations: ['A', 'B'].map((id) => ({ id: `conv-${id}`, organization_id: 'org', channel_session_id: id,
      contact_id: 'contact', is_group: false, last_inbound_at: new Date().toISOString(), bot_silenced_until: null })),
    meta_templates: ['A', 'B'].map((id) => ({ id: `tpl-${id}`, organization_id: 'org', channel_session_id: id,
      name: 'retorno', language: 'pt_BR', status: 'APPROVED', contract_hash: 'hash', parameter_format: 'NAMED',
      components: [{ type: 'BODY', text: 'Olá {{customer_name}}' }] })),
    messages: [],
  };
  activeDb = database();
  vi.stubEnv('META_PHONE_NUMBER_ID', 'GLOBAL-B'); vi.stubEnv('META_SYSTEM_USER_TOKEN', 'GLOBAL-TOKEN-B');
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url)); return realFetch(receiver, init);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function send(id = 'A', template = true, values = { customer_name: 'Ana' } as Record<string, string>) {
  return sendMessageHandler(activeDb, { organization_id: 'org', actor: { type: 'user', id: 'user' }, requestId: 'request' }, {
    conversation_id: `conv-${id}`, ...(template ? { type: 'template' as const, template_name: 'retorno',
      template_language: 'pt_BR', template_values: values } : { type: 'text' as const, body: 'Oi' }),
  });
}

describe('transporte Meta session-bound no sink real', () => {
  it('A e B usam seus números/tokens, mesmo com templates iguais e env global divergente', async () => {
    expect((await send('A')).status).toBe('sent'); expect((await send('B')).status).toBe('sent');
    expect(urls[0]).toContain('/phone-A/messages'); expect(urls[1]).toContain('/phone-B/messages');
    expect(requests.map((r) => r.authorization)).toEqual(['Bearer token-A', 'Bearer token-B']);
  });
  it('NAMED chega ao receiver com parameter_name', async () => {
    await send();
    expect(requests[0]?.body.template).toMatchObject({ components: [{ type: 'body', parameters: [
      { type: 'text', text: 'Ana', parameter_name: 'customer_name' },
    ] }] });
  });
  it('POSITIONAL continua sem parameter_name', async () => {
    Object.assign(tables.meta_templates![0]!, { parameter_format: 'POSITIONAL', components: [{ type: 'BODY', text: 'Olá {{1}}' }] });
    await send('A', true, { '1': 'Ana' });
    expect(requests[0]?.body.template).toMatchObject({ components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }] });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('parameter_name');
  });
  it.each([true, false])('credencial só no banco funciona, template=%s', async (template) => {
    vi.stubEnv('META_PHONE_NUMBER_ID', ''); vi.stubEnv('META_SYSTEM_USER_TOKEN', '');
    expect(getAdapter('meta_cloud').isConfigured({ channelSessionId: 'A' })).toBe(true);
    expect((await send('A', template)).status).toBe('sent');
    expect(requests[0]?.authorization).toBe('Bearer token-A');
  });
  it.each([true, false])('sem credencial de A não usa B nem env, template=%s', async (template) => {
    tables.channel_sessions![0]!.meta_token_encrypted = null;
    expect(await send('A', template)).toMatchObject({ status: 'failed', error_message: 'meta_session_credentials_missing' });
    expect(requests).toHaveLength(0);
  });
  it('falha de decifra não autoriza env', async () => {
    decryptFails = true;
    expect((await send()).status).toBe('failed'); expect(requests).toHaveLength(0);
  });
  it('credencial de outro tenant não pode ser usada', async () => {
    tables.channel_sessions![0]!.organization_id = 'foreign';
    expect((await send()).status).toBe('failed'); expect(requests).toHaveLength(0);
  });
  it('template de outro tenant ou sessão não é escolhido pelo nome', async () => {
    tables.meta_templates![0]!.organization_id = 'foreign';
    expect((await send()).status).toBe('failed'); expect(requests).toHaveLength(0);
  });
});

describe('confirmação exige estado confirmado E identificador externo', () => {
  // A travessia do ledger/retry roda em PostgreSQL em followup-inline-ledger.test.ts.
  it.each(['queued','sending','sent','delivered','read','failed','unknown'])('mensagem %s não confirma sem ID', (status) => {
    expect(decideOutboundRecovery('requested',{id:'msg',status,external_id:null,metadata:{}})).not.toBe('confirmed');
  });
  it.each(['sent','delivered','read'])('%s com ID confirma', (status) => {
    expect(decideOutboundRecovery('queued',{id:'msg',status,external_id:'wamid',metadata:{}})).toBe('confirmed');
  });
});
