// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { outboundPostgres, ORG, CONTACT, CONV, JOB } from '../helpers/outbound-postgres';
import { availableConversationAudios, assertConversationAudioAvailable, explicitAudioPreference } from '@/lib/agent-engine/agent/conversation-audios';
import { readApprovedAudios, renderApprovedAudios } from '@/lib/ai/agents/approved-audios';
import { requiredAudioPlan, deliverRequiredAudio } from '@/lib/agent-engine/agent/required-audio';
import type { JobRow } from '@/lib/agent-engine/queue/queue';

const AGENT = '10000000-0000-4000-8000-000000000060';
const AUDIO = '10000000-0000-4000-8000-000000000061';
const MESSAGE = '10000000-0000-4000-8000-000000000062';
const OTHER = '10000000-0000-4000-8000-000000000063';
const audios = readApprovedAudios({ approved_audios: [{ id: AUDIO, title: 'Recepção',
  use_when: 'Apresentação aprovada para primeiro contato', storage_path: `${ORG}/agent-audios/${AGENT}/${AUDIO}.ogg`,
  mime: 'audio/ogg', size_bytes: 10, enabled: true, required: true }] });
let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.seed();
  await db.pool.query("update job_queue set kind='inbound_turn',status='running',locked_by='audio-test'");
});
const available = (job = OTHER, inbound: string | null = null) => availableConversationAudios(db.pool, ORG, CONV, AGENT, job, audios, inbound);
async function held(status: string, phase: string, ownJob = false) {
  if (ownJob) await db.pool.query("insert into send_ledger(id,organization_id,job_id,seq) values($1,$2,$3,1)", [MESSAGE, ORG, JOB]);
  await db.pool.query(`insert into messages(id,organization_id,contact_id,conversation_id,type,direction,status,metadata)
    values($1,$2,$3,$4,'audio','outbound',$5,$6)`, [MESSAGE, ORG, CONTACT, CONV, status,
    JSON.stringify({ idempotency_key: MESSAGE, approved_audio: { agent_id: AGENT, audio_id: AUDIO },
      outbound_attempt: { phase, retryable: phase === 'prepared' } })]);
}
it.each([['sent','confirmed'], ['queued','prepared'], ['failed','uncertain'], ['sending','started']])('não oferece de novo gravação %s/%s em outro turno', async (status, phase) => {
  await held(status, phase);
  expect(await available()).toEqual([]);
  await expect(assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, AUDIO, OTHER)).rejects.toMatchObject({ message: 'audio_already_used' });
});
it('replay mantém o áudio do mesmo job, mas outra intenção não o repete', async () => {
  await held('queued', 'prepared', true);
  expect(await available(JOB)).toEqual(audios);
  await expect(assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, AUDIO, MESSAGE)).resolves.toBeUndefined();
  await expect(assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, AUDIO, OTHER)).rejects.toMatchObject({ message: 'audio_already_used' });
});
it('veto terminal comprovadamente anterior à rede não consome a gravação', async () => {
  await held('failed', 'rejected');
  expect(await available()).toEqual(audios);
});
it.each(['workspace','conversation'])('não mistura histórico de outro %s', async scope => {
  await held('sent', 'confirmed');
  await db.pool.query(`update messages set ${scope === 'workspace' ? 'organization_id' : 'conversation_id'}=$1`, [OTHER]);
  expect(await available()).toEqual(audios);
});
it('pedido de texto persiste entre turnos, e autorização explícita posterior permite áudio', async () => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,created_at)
    values($1,$2,$3,'inbound','Prefiro só texto, por favor','2026-01-01')`, [MESSAGE, ORG, CONV]);
  expect(await available(OTHER, MESSAGE)).toEqual([]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,created_at)
    values($1,$2,$3,'inbound','Qual o preço?','2026-01-02')`, [OTHER, ORG, CONV]);
  expect(await available(OTHER, OTHER)).toEqual([]);
  await expect(assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, AUDIO, AGENT)).rejects.toMatchObject({ message: 'audio_text_preference' });
  await db.pool.query("update messages set body='Pode me enviar áudio agora' where id=$1", [OTHER]);
  expect(await available(OTHER, OTHER)).toEqual(audios);
});
it.each(['Não quero áudio', 'Não pode enviar áudio', 'Sem áudio, por favor', 'No me envíe audio', 'Only text please', 'Please do not send voice messages'])('identifica preferência explícita: %s', text => {
  expect(explicitAudioPreference(text)).toBe('text');
});
it('pergunta sobre áudio não cria preferência nem bloqueio', () => {
  expect(explicitAudioPreference('Você envia áudio?')).toBeNull();
  expect(explicitAudioPreference('Como uso o aplicativo?')).toBeNull();
});
async function job() { return (await db.pool.query<JobRow>('select * from job_queue where id=$1', [JOB])).rows[0]!; }
it('plano obrigatório persiste sob lease e não muda no retry', async () => {
  const plan = await requiredAudioPlan(db.pool, await job(), 'audio-test', AGENT, audios, 3);
  expect(plan).toEqual({ agent_id: AGENT, audio_id: AUDIO });
  expect(await requiredAudioPlan(db.pool, await job(), 'audio-test', AGENT, [], 3)).toEqual(plan);
  await expect(requiredAudioPlan(db.pool, await job(), 'outro-worker', AGENT, [], 3)).rejects.toMatchObject({ name: 'OutboundLeaseLostError' });
});
it('quem perdeu lease não persiste plano', async () => {
  await expect(requiredAudioPlan(db.pool, await job(), 'outro-worker', AGENT, audios, 3)).rejects.toMatchObject({ name: 'OutboundLeaseLostError' });
});
it('modo opcional e limite insuficiente não iniciam recepção automática', async () => {
  expect(await requiredAudioPlan(db.pool, await job(), 'audio-test', AGENT, audios.map(a => ({ ...a, required: false })), 3)).toBeNull();
  expect(await requiredAudioPlan(db.pool, await job(), 'audio-test', AGENT, audios, 1)).toBeNull();
});
it('catálogo legado segue opcional e obrigatórios não dependem da escolha do modelo', () => {
  const legacy = { ...audios[0], required: undefined };
  const parsed = readApprovedAudios({ approved_audios: [legacy] });
  expect(parsed[0]?.required).toBe(false);
  expect(renderApprovedAudios(audios)).toBe('');
  expect(renderApprovedAudios(parsed)).toContain(AUDIO);
});
it('recepção usa a ferramenta existente para contexto e áudio, reservando as duas intenções', async () => {
  const invoke = vi.fn(async () => ({ ok: true, status: 'enviada' })); const reserve = vi.fn();
  const result = await deliverRequiredAudio({ plan: { agent_id: AGENT, audio_id: AUDIO }, agent: AGENT, audios, invoke, reserve, discard: vi.fn() });
  expect(result).toMatchObject({ title: 'Recepção', content_description: audios[0]!.use_when, result: { ok: true, status: 'enviada' } });
  expect(invoke.mock.calls).toEqual([[{ body: 'Vou te enviar uma breve orientação em áudio.' }],
    [{ body: 'Recepção', media: { type: 'audio', audio_id: AUDIO } }]]);
  expect(reserve).toHaveBeenCalledOnce();
});
it('contexto queued impede enviar áudio adiantado; aprovação alterada preserva reserva', async () => {
  const invoke = vi.fn(async () => ({ ok: true, status: 'aceita_aguardando_canal' })); const reserve = vi.fn();
  const plan = { agent_id: AGENT, audio_id: AUDIO };
  const discard = vi.fn(async () => {});
  await deliverRequiredAudio({ plan, agent: AGENT, audios, invoke, reserve, discard });
  expect(invoke).toHaveBeenCalledOnce();
  invoke.mockClear();
  await deliverRequiredAudio({ plan, agent: AGENT, audios: [], invoke, reserve, discard });
  expect(invoke).not.toHaveBeenCalled(); expect(reserve).toHaveBeenCalledTimes(2);
  expect(discard).toHaveBeenCalledOnce();
});
