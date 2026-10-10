// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type * as AudioModule from '@/lib/messaging/media/prerecorded-audio';
import { outboundPostgres, ORG, CONV } from '../helpers/outbound-postgres';
import { GET, POST, PATCH, DELETE } from '@/app/api/v1/ai/agents/[id]/audios/route';
import { POST as uploadConversationMedia } from '@/app/api/v1/conversations/[id]/media/route';

const AGENT = '10000000-0000-4000-8000-000000000060';
const PIPELINE = '10000000-0000-4000-8000-000000000071';
const STAGE = '10000000-0000-4000-8000-000000000072';
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
  expect(audio).toMatchObject({ enabled: true, required: true, mime: 'audio/ogg', title: 'Apresentação' });
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
  expect((await (await GET(request('GET'), ctx)).json()).data[0].required).toBe(true);
  expect((await DELETE(request('DELETE', { audio_id: audio.id }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data).toEqual([]);
  expect(state.audit).toHaveBeenCalledTimes(4);
});
it('permite cadastrar opcional e alterar o modo sem reenviar a gravação', async () => {
  const data = form(); data.set('required', 'false');
  expect((await POST(request('POST', data), ctx)).status).toBe(200);
  const audio = (await (await GET(request('GET'), ctx)).json()).data[0]; expect(audio.required).toBe(false);
  expect((await PATCH(request('PATCH', { audio_id: audio.id, required: true }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data[0].required).toBe(true);
  expect(state.upload).toHaveBeenCalledOnce();
});
it('recusa modo de envio malformado antes de preparar arquivo', async () => {
  const data = form(); data.set('required', 'yes');
  expect((await POST(request('POST', data), ctx)).status).toBe(422);
  expect(state.normalize).not.toHaveBeenCalled(); expect(state.upload).not.toHaveBeenCalled();
});
it('não lê, assina nem escreve áudio de outra organização', async () => {
  await add(); state.org = AGENT; state.upload.mockClear();
  expect((await GET(request('GET'), ctx)).status).toBe(404);
  expect((await POST(request('POST', form()), ctx)).status).toBe(404);
  expect(state.upload).not.toHaveBeenCalled();
});
it('está disponível também em outro workspace, com armazenamento próprio', async () => {
  await db.pool.query('update ai_agents set organization_id=$1', [AGENT]); state.org = AGENT;
  const audio = await add(); expect(audio.storage_path).toBe(`${AGENT}/agent-audios/${AGENT}/${audio.id}.ogg`);
});
it('lista etapas do workspace, vincula no cadastro, preserva e edita a seleção', async () => {
  await db.pool.query('insert into crm_pipelines(id,organization_id,name) values($1,$2,$3)', [PIPELINE, ORG, 'Suporte']);
  await db.pool.query('insert into crm_stages(id,organization_id,pipeline_id,name) values($1,$2,$3,$4)', [STAGE, ORG, PIPELINE, 'Orientação']);
  const data = form(); data.set('stage_ids', JSON.stringify([STAGE]));
  expect((await POST(request('POST', data), ctx)).status).toBe(200);
  const json = await (await GET(request('GET'), ctx)).json();
  expect(json.meta.stage_options).toEqual([{ id: STAGE, name: 'Orientação', pipeline_id: PIPELINE, pipeline_name: 'Suporte' }]);
  const audio = json.data[0]; expect(audio.stage_ids).toEqual([STAGE]);
  expect((await PATCH(request('PATCH', { audio_id: audio.id, title: 'Orientação do suporte' }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data[0].stage_ids).toEqual([STAGE]);
  expect((await PATCH(request('PATCH', { audio_id: audio.id, stage_ids: [] }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data[0].stage_ids).toEqual([]);
});
it.each(['foreign', 'archived_stage', 'archived_pipeline', 'invalid_json'])('recusa vínculo %s sem guardar arquivo', async reason => {
  await db.pool.query('insert into crm_pipelines(id,organization_id,name,is_archived) values($1,$2,$3,$4)', [PIPELINE, reason === 'foreign' ? AGENT : ORG, 'Outro funil', reason === 'archived_pipeline']);
  await db.pool.query('insert into crm_stages(id,organization_id,pipeline_id,name,is_archived) values($1,$2,$3,$4,$5)', [STAGE, reason === 'foreign' ? AGENT : ORG, PIPELINE, 'Etapa', reason === 'archived_stage']);
  const data = form(); data.set('stage_ids', reason === 'invalid_json' ? '{broken' : JSON.stringify([STAGE]));
  expect((await POST(request('POST', data), ctx)).status).toBe(422);
  expect(state.upload).not.toHaveBeenCalled(); expect(state.normalize).not.toHaveBeenCalled();
  const json = await (await GET(request('GET'), ctx)).json(); expect(json.meta.stage_options).toEqual(reason === 'invalid_json'
    ? [{ id: STAGE, name: 'Etapa', pipeline_id: PIPELINE, pipeline_name: 'Outro funil' }] : []);
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

it('persiste assunto/condição e preserva a regra ao editar somente o título', async () => {
  const data = form(); data.set('trigger_type', 'topic'); data.set('send_when', 'Quando perguntar como funciona, exceto preço.');
  expect((await POST(request('POST', data), ctx)).status).toBe(200);
  const audio = (await (await GET(request('GET'), ctx)).json()).data[0];
  expect(audio).toMatchObject({ trigger_type: 'topic', send_when: 'Quando perguntar como funciona, exceto preço.' });
  expect((await PATCH(request('PATCH', { audio_id: audio.id, title: 'Funcionamento' }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data[0]).toMatchObject({ trigger_type: 'topic', send_when: audio.send_when });
  expect((await PATCH(request('PATCH', { audio_id: audio.id, trigger_type: 'first_contact' }), ctx)).status).toBe(200);
  expect((await (await GET(request('GET'), ctx)).json()).data[0]).toMatchObject({ trigger_type: 'first_contact', send_when: audio.send_when });
});
it.each(['invalid_trigger', 'condition_too_long'])('recusa regra malformada %s antes do Storage', async reason => {
  const data = form();
  data.set(reason === 'invalid_trigger' ? 'trigger_type' : 'send_when', reason === 'invalid_trigger' ? 'stage_entry' : 'a'.repeat(1001));
  expect((await POST(request('POST', data), ctx)).status).toBe(422);
  expect(state.upload).not.toHaveBeenCalled(); expect(state.normalize).not.toHaveBeenCalled();
});
