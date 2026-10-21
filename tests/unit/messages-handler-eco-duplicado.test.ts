import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';
import { outboundPostgres, ORG, CONV, CONTACT, SESSION } from '../helpers/outbound-postgres';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

/** O handler e o trigger de identidade executam SQL real. A reconciliação usa
 * ID confirmado, preserva a linha do eco e as suas referências; a consulta do
 * Inbox oculta metadata.reconciled_into_message_id. Sem réplica JS do trigger. */
const USER = '55555555-5555-4555-8555-555555555555';
const ECHO = '66666666-6666-4666-8666-666666666666';
const OTHER = '99999999-9999-4999-8999-999999999999';
const BARE = '3EB0ABCDEF0123456789';
const COMPOSTO = `true_5511000000000@c.us_${BARE}`;
type Row = Record<string, unknown>;
let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
beforeEach(async () => { await db.seed(); });
afterAll(async () => { await db?.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function seedEcho(over: Row = {}) {
  const result = await db.supabase.from('messages').insert({
    id: ECHO, organization_id: ORG, conversation_id: CONV, contact_id: CONTACT,
    channel_session_id: SESSION, external_id: COMPOSTO, type: 'text', direction: 'outbound',
    status: 'sent', body: 'oi', sent_via: 'external_device', ...over,
  });
  expect(result.error).toBeNull();
}
async function messages() {
  return (await db.pool.query<Row>('select * from messages order by created_at,id')).rows;
}
function wahaRespondendo() {
  vi.stubEnv('WAHA_API_BASE_URL', 'http://localhost:3030');
  vi.stubEnv('WAHA_API_KEY', 'hash123');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: { id: BARE } }), { status: 200 })));
}
const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };
const input = { conversation_id: CONV, type: 'text', body: 'oi' } as SendMessageInput;
async function send() {
  wahaRespondendo();
  await sendMessageHandler(db.supabase, ctx, input);
  return messages();
}

describe('eco do envio confirmado, com trigger PostgreSQL real', () => {
  it('o eco que chegou primeiro não deixa a frase duplicada', async () => {
    await seedEcho();
    const rows = await send();
    expect(rows.filter(m => m.external_id === BARE || m.external_id === COMPOSTO)).toHaveLength(1);
    const archived = rows.find(m => m.id === ECHO)!;
    expect(archived.external_id).toBeNull();
    expect(archived.metadata).toMatchObject({ reconciled_into_message_id: expect.any(String), original_external_id: BARE });
    expect(rows, 'a referência do eco deve continuar no histórico').toHaveLength(2);
  });
  it('a linha visível é a do ENVIO, com autoria', async () => {
    await seedEcho();
    const rows = await send();
    const visible = rows.filter(m => !(m.metadata as Row).reconciled_into_message_id);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ sent_by_user_id: USER, sent_via: 'user', status: 'sent', external_id: BARE });
  });
  it('sem eco nenhum, preserva o envio normal', async () => {
    const rows = await send();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ external_id: BARE, status: 'sent' });
  });
  it('mensagem humana de mesmo texto e outro ID continua visível', async () => {
    await seedEcho({ external_id: 'true_5511000000000@c.us_3EB0OUTRAMENSAGEM99' });
    const rows = await send();
    expect(rows).toHaveLength(2);
    expect(rows.find(m => m.id === ECHO)).toMatchObject({ external_id: '3EB0OUTRAMENSAGEM99', metadata: {} });
  });
  it('eco com o mesmo ID em OUTRA conversa não é reconciliado', async () => {
    await seedEcho({ conversation_id: OTHER });
    const rows = await send();
    expect(rows.find(m => m.id === ECHO)).toMatchObject({ conversation_id: OTHER, external_id: BARE, metadata: {} });
  });
  it('linha do CRM com o mesmo ID não é arquivada', async () => {
    await seedEcho({ sent_via: 'ai' });
    const rows = await send();
    expect(rows.find(m => m.id === ECHO)).toMatchObject({ sent_via: 'ai', external_id: BARE, metadata: {} });
  });
});
