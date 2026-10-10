// @vitest-environment node
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { outboundPostgres, ORG, CONTACT, CONV, JOB } from '../helpers/outbound-postgres';
import { readApprovedAudios } from '@/lib/ai/agents/approved-audios';
import { audioIntentMessage, parseAudioIntent, decideRequiredAudio, isFirstAudioContact } from '@/lib/agent-engine/agent/audio-rule';
import { requiredAudioPlan, deliverRequiredAudio } from '@/lib/agent-engine/agent/required-audio';
import type { JobRow } from '@/lib/agent-engine/queue/queue';

const AGENT = '10000000-0000-4000-8000-000000000060';
const AUDIO = '10000000-0000-4000-8000-000000000061';
const MESSAGE = '10000000-0000-4000-8000-000000000062';
const OTHER = '10000000-0000-4000-8000-000000000063';
const audios = readApprovedAudios({ approved_audios: [{ id: AUDIO, title: 'Como funciona',
  use_when: 'Explicação gravada do serviço', send_when: 'Quando perguntar como funciona, exceto preço.',
  storage_path: `${ORG}/agent-audios/${AGENT}/${AUDIO}.ogg`, mime: 'audio/ogg', size_bytes: 10, enabled: true, required: true }] });
let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.seed(); await db.pool.query("update job_queue set kind='inbound_turn',status='running',locked_by='audio-test'");
});
async function job() { return (await db.pool.query<JobRow>('select * from job_queue where id=$1', [JOB])).rows[0]!; }
const decide = async (classify: (candidates: typeof audios) => Promise<string | null>, firstContact = false, catalog = audios) =>
  decideRequiredAudio({ db: db.pool, job: await job(), worker: 'audio-test', agent: AGENT, audios: catalog, firstContact, classify });

it.each(['não é JSON', '{"audio_id":"inventado"}', JSON.stringify({ audio_id: OTHER }), JSON.stringify({ audio_id: AUDIO, send: true }), '{"audio_id":null}'])('resposta inválida ou sem assunto não libera gravação: %s', text => {
  expect(parseAudioIntent(text, audios)).toBeNull();
});
it('só aceita ID aprovado e separa pergunta atual das regras configuradas', () => {
  expect(parseAudioIntent(JSON.stringify({ audio_id: AUDIO }), audios)).toBe(AUDIO);
  const prompt = JSON.parse(audioIntentMessage('Como funciona?', audios));
  expect(prompt).toMatchObject({ mensagem_atual: 'Como funciona?', regras: [{ condicao: audios[0]!.send_when, conteudo: audios[0]!.use_when }] });
});
it('persiste inclusive decisão sem assunto e não reclassifica após mudança de catálogo', async () => {
  const classify = vi.fn(async () => null);
  expect(await decide(classify)).toBeNull();
  expect(await decide(async () => AUDIO)).toBeNull();
  expect(classify).toHaveBeenCalledOnce();
  expect((await job()).payload.audio_rule_decision).toEqual({ agent_id: AGENT, audio_id: null });
});
it('assunto correspondente reserva plano após resposta; retry mantém gravação e fase', async () => {
  expect(await decide(async () => AUDIO)).toBe(AUDIO);
  expect(await decide(async () => OTHER)).toBe(AUDIO);
  const plan = await requiredAudioPlan(db.pool, await job(), 'audio-test', AGENT, audios, 3, 'after_response');
  expect(plan).toMatchObject({ audio_id: AUDIO, delivery_phase: 'after_response' });
  expect(await requiredAudioPlan(db.pool, await job(), 'audio-test', AGENT, [], 3)).toEqual(plan);
});
it('não introduz reserva nova em retry legado que já usou o ledger', async () => {
  await db.pool.query('insert into send_ledger(organization_id,job_id,seq) values($1,$2,1)', [ORG, JOB]);
  const classify = vi.fn(async () => AUDIO);
  expect(await decide(classify)).toBeNull(); expect(classify).not.toHaveBeenCalled();
});
it('decisão não atravessa lease nem workspace', async () => {
  await db.pool.query('update job_queue set locked_by=$1', ['outro']);
  await expect(decide(async () => AUDIO)).rejects.toMatchObject({ name: 'OutboundLeaseLostError' });
  await db.pool.query('update job_queue set locked_by=$1,organization_id=$2', ['audio-test', OTHER]);
  const stale = { ...(await job()), organization_id: ORG };
  await expect(decideRequiredAudio({ db: db.pool, job: stale, worker: 'audio-test', agent: AGENT, audios,
    firstContact: false, classify: async () => AUDIO })).rejects.toMatchObject({ name: 'OutboundLeaseLostError' });
});
it('recepção só corresponde ao primeiro atendimento, sem chamada auxiliar desnecessária', async () => {
  const greeting = audios.map(a => ({ ...a, trigger_type: 'first_contact' as const }));
  const classify = vi.fn(async () => AUDIO);
  expect(await decide(classify, false, greeting)).toBeNull(); expect(classify).not.toHaveBeenCalled();
  await db.pool.query("update job_queue set payload='{}'");
  expect(await decide(classify, true, greeting)).toBe(AUDIO); expect(classify).not.toHaveBeenCalled();
});
it('primeiro contato vem do histórico da conversa, isolado e estável no retry', async () => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,direction,created_at)
    values($1,$2,$3,$4,'inbound','2026-01-02')`, [MESSAGE, ORG, CONV, CONTACT]);
  const first = () => isFirstAudioContact(db.pool, ORG, CONV, JOB, MESSAGE);
  expect(await first()).toBe(true);
  expect(await isFirstAudioContact(db.pool, OTHER, CONV, JOB, MESSAGE)).toBe(false);
  await db.pool.query('insert into send_ledger(id,organization_id,job_id,seq) values($1,$2,$3,3)', [OTHER, ORG, JOB]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,created_at,metadata)
    values($1,$2,$3,'outbound','2026-01-01',$4)`, [OTHER, ORG, CONV, JSON.stringify({ idempotency_key: OTHER })]);
  expect(await first()).toBe(true);
  await db.pool.query("update messages set direction='inbound' where id=$1", [OTHER]);
  expect(await first()).toBe(false);
});
it('texto já confirmado é contexto suficiente: envia áudio sem repetir a introdução', async () => {
  const invoke = vi.fn(async () => ({ ok: true, status: 'enviada' }));
  await deliverRequiredAudio({ plan: { agent_id: AGENT, audio_id: AUDIO, delivery_phase: 'after_response' },
    agent: AGENT, audios, invoke, contextAlreadySent: true, reserve: vi.fn(), discard: vi.fn() });
  expect(invoke.mock.calls).toEqual([[{ body: 'Como funciona', media: { type: 'audio', audio_id: AUDIO } }]]);
});
