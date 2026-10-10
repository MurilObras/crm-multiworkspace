// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type * as AudioModule from '@/lib/messaging/media/prerecorded-audio';
import { outboundPostgres, ORG, CONV } from '../helpers/outbound-postgres';
import { GET, POST, PATCH, DELETE } from '@/app/api/v1/ai/agents/[id]/audios/route';
import { POST as uploadConversationMedia } from '@/app/api/v1/conversations/[id]/media/route';

const AGENT = '10000000-0000-4000-8000-000000000060';
const state = vi.hoisted(() => ({ admin: null as unknown as SupabaseClient, org: '10000000-0000-4000-8000-000000000001',
  authorized: true, role: '', upload: vi.fn(async (..._args: unknown[]) => ({ error: null })),
  remove: vi.fn(async () => ({ error: null })), normalize: vi.fn(async () => Buffer.from('OggSOpusHead-test')),
  audit: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/require-role', () => ({ requireRole: async (role: string) => {
  state.role = role;
  return state.authorized ? { ok: true, user: { id: AGENT }, org: { orgId: state.org } }
    : { ok: false, response: new Response(null, { status: 403 }) };
} }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.admin }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => state.admin }));
vi.mock('@/lib/auth/server', () => ({ loadAuthUser: async () => ({ id: AGENT }), resolveActiveOrg: async () => ({ orgId: state.org }) }));
vi.mock('@/lib/audit', () => ({ audit: state.audit }));
vi.mock('@/lib/messaging/media/prerecorded-audio', async importOriginal => ({
  ...await importOriginal<typeof AudioModule>(), normalizePrerecordedAudio: state.normalize,
}));
let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => {
  db = await outboundPostgres();
  await db.pool.query('create table ai_agents(id uuid primary key,organization_id uuid,kind text,archived_at timestamptz,config jsonb)');
  state.admin = { ...db.supabase, storage: { from: () => ({ upload: state.upload, remove: state.remove,
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://private.example/${path}` } }) }) } } as unknown as SupabaseClient;
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  vi.clearAllMocks(); state.org = ORG; state.authorized = true;
  await db.seed();
  await db.pool.query('delete from ai_agents');
  await db.pool.query("insert into ai_agents values($1,$2,'mcp_agent',null,$3)", [AGENT, ORG, JSON.stringify({ rag_top_k: 8 })]);
});
const ctx = { params: Promise.resolve({ id: AGENT }) };
function request(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}/audios`, { method,
    ...(body instanceof FormData ? { body } : body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
}
function form(mime = 'audio/mpeg') {
  const data = new FormData(); data.set('file', new File(['mp3'], 'apresentacao.mp3', { type: mime }));
  data.set('title', 'Apresentação'); data.set('use_when', 'Quando o cliente perguntar como funciona o aplicativo.'); return data;
}
async function add() {
  expect((await POST(request('POST', form()), ctx)).status).toBe(200);
  const res = await GET(request('GET'), ctx); return (await res.json()).data[0];
}
it('aprova, ouve, desativa e remove no workspace, preservando os knobs existentes', async () => {
  const audio = await add();
  expect(audio).toMatchObject({ enabled: true, mime: 'audio/ogg', title: 'Apresentação' });
  expect(audio.storage_path).toBe(`${ORG}/agent-audios/${AGENT}/${audio.id}.ogg`);
  expect(audio.preview_url).toContain('https://private.example/');
  const stored = (await db.pool.query('select config from ai_agents')).rows[0]!.config;
  expect(stored.rag_top_k).toBe(8); expect(JSON.stringify(stored)).not.toContain('https://');
  expect((await PATCH(request('PATCH', { audio_id: audio.id, enabled: false }), ctx)).status).toBe(200);
  expect(state.role).toBe('admin');
  expect((await (await GET(request('GET'), ctx)).json()).data[0].enabled).toBe(false);
  expect(state.role).toBe('manager');
  expect((await PATCH(request('PATCH', { audio_id: audio.id, title: 'Nova apresentação', use_when: 'Somente quando o cliente pedir detalhes.' }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data[0]).toMatchObject({ enabled: false, title: 'Nova apresentação' });
  expect((await DELETE(request('DELETE', { audio_id: audio.id }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data).toEqual([]);
  expect(state.audit).toHaveBeenCalledTimes(4);
});
it('não lê, assina nem escreve áudio de outra organização', async () => {
  await add(); state.org = AGENT; state.upload.mockClear();
  expect((await GET(request('GET'), ctx)).status).toBe(404);
  expect((await POST(request('POST', form()), ctx)).status).toBe(404);
  expect(state.upload).not.toHaveBeenCalled();
});
it('respeita a rejeição do guard de papel antes de acessar Storage', async () => {
  state.authorized = false;
  expect((await POST(request('POST', form()), ctx)).status).toBe(403);
  expect(state.upload).not.toHaveBeenCalled();
});
it('CAS rejeita concorrência e remove só o novo objeto sem perder outra edição', async () => {
  state.upload.mockImplementationOnce(async () => {
    await db.pool.query("update ai_agents set config='{}'::jsonb || jsonb_build_object('rag_top_k',12)"); return { error: null };
  });
  expect((await POST(request('POST', form()), ctx)).status).toBe(409);
  expect((await db.pool.query('select config from ai_agents')).rows[0]!.config).toEqual({ rag_top_k: 12 });
  expect(state.remove).toHaveBeenCalledOnce(); expect(state.audit).not.toHaveBeenCalled();
});
it('recusa tipo inválido, tamanho declarado excessivo e falha de decodificação sem aprovar', async () => {
  expect((await POST(request('POST', form('text/html')), ctx)).status).toBe(415);
  const oversized = request('POST', form()); oversized.headers.set('content-length', String(18 * 1024 * 1024));
  expect((await POST(oversized, ctx)).status).toBe(413);
  state.normalize.mockRejectedValueOnce(new Error('invalid audio'));
  expect((await POST(request('POST', form()), ctx)).status).toBe(422);
  expect(state.upload).not.toHaveBeenCalled();
});
it.each(['audio/mpeg', 'audio/webm'])('upload manual %s usa arquivo normalizado e devolve seu MIME/tamanho reais', async mime => {
  const res = await uploadConversationMedia(request('POST', form(mime)), { params: Promise.resolve({ id: CONV }) });
  expect(res.status).toBe(200); expect(state.role).toBe('agent');
  expect((await res.json()).data).toMatchObject({ media_mime: 'audio/ogg', media_size_bytes: 17, kind: 'audio' });
  expect(state.upload.mock.calls[0]?.[0]).toMatch(new RegExp(`^${ORG}/${CONV}/out-.+\\.ogg$`));
});
it('erro de conversão no inbox não guarda original incompatível; vídeo mantém seu formato', async () => {
  state.normalize.mockRejectedValueOnce(new Error('invalid'));
  const ctx = { params: Promise.resolve({ id: CONV }) };
  expect((await uploadConversationMedia(request('POST', form()), ctx)).status).toBe(422);
  expect(state.upload).not.toHaveBeenCalled();
  const res = await uploadConversationMedia(request('POST', form('video/webm')), ctx);
  expect((await res.json()).data).toMatchObject({ media_mime: 'video/webm', media_size_bytes: 3, kind: 'video' });
  expect(state.normalize).toHaveBeenCalledOnce();
});
