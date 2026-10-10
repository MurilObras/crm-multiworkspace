// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { outboundPostgres, ORG, CONTACT, CONV, JOB, SESSION } from '../helpers/outbound-postgres';
import { isFirstAudioContact, decideRequiredAudio, pendingAudioSubject, AUDIO_INTENT_INSTRUCTION } from '@/lib/agent-engine/agent/audio-rule';
import { coalesceInboundDebounce } from '@/lib/agent-engine/queue/inbound-pending';
import { availableConversationAudios, conversationAllowsAudio, assertConversationAudioAvailable } from '@/lib/agent-engine/agent/conversation-audios';
import { readApprovedAudios } from '@/lib/ai/agents/approved-audios';
import type { JobRow } from '@/lib/agent-engine/queue/queue';

const FIRST = '10000000-0000-4000-8000-000000000080';
const LAST = '10000000-0000-4000-8000-000000000081';
const EVENT = '10000000-0000-4000-8000-000000000082';
const AGENT = '10000000-0000-4000-8000-000000000083';
const AUDIO = '10000000-0000-4000-8000-000000000084';
let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.seed();
  await db.pool.query(`update job_queue set kind='inbound_turn',status='pending',last_error=null,
    run_after=now()+interval '10 seconds',payload=$1 where id=$2`,
  [JSON.stringify({ conversation_id: CONV, channel_session_id: SESSION, inbound_message_id: FIRST }), JOB]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,direction,body,created_at)
    values($1,$2,$3,$4,'inbound','Oi',now()-interval '2 seconds')`, [FIRST,ORG,CONV,CONTACT]);
});
it('controle: uma única inbound antes da primeira resposta permite recepção', async () => {
  expect(await isFirstAudioContact(db.pool, ORG, CONV, JOB, FIRST)).toBe(true);
});
it('recepção obrigatória continua elegível quando duas mensagens iniciais são agrupadas', async () => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,direction,body,created_at)
    values($1,$2,$3,$4,'inbound','Tudo bem?',now())`, [LAST,ORG,CONV,CONTACT]);
  expect(await coalesceInboundDebounce(db.pool, { organizationId:ORG,contactId:CONTACT,conversationId:CONV,
    channelSessionId:SESSION,messageId:LAST,eventId:EVENT,debounceMs:30_000 })).toBe(JOB);
  await db.pool.query("update job_queue set status='running',locked_by='review' where id=$1", [JOB]);
  const job = (await db.pool.query<JobRow>('select * from job_queue where id=$1',[JOB])).rows[0]!;
  expect(job.payload.inbound_message_id).toBe(LAST);
  const firstContact = await isFirstAudioContact(db.pool, ORG, CONV, JOB, LAST);
  const audios = readApprovedAudios({approved_audios:[{id:AUDIO,title:'Recepção',use_when:'Apresentação do atendimento',
    trigger_type:'first_contact',required:true,enabled:true,mime:'audio/ogg',size_bytes:17,
    storage_path:`${ORG}/agent-audios/${AGENT}/${AUDIO}.ogg`}]});
  const decision = await decideRequiredAudio({db:db.pool,job,worker:'review',agent:AGENT,audios,firstContact,classify:async()=>null});
  expect({ firstContact, decision }).toEqual({firstContact:true,decision:AUDIO});
});
it('pedido de texto na primeira mensagem de uma rajada bloqueia áudio na resposta agrupada', async () => {
  await db.pool.query("update messages set body='Prefiro apenas texto, por favor' where id=$1",[FIRST]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,direction,body,created_at)
    values($1,$2,$3,$4,'inbound','Como funciona o aplicativo?',now())`, [LAST,ORG,CONV,CONTACT]);
  expect(await coalesceInboundDebounce(db.pool, {organizationId:ORG,contactId:CONTACT,conversationId:CONV,
    channelSessionId:SESSION,messageId:LAST,eventId:EVENT,debounceMs:30_000})).toBe(JOB);
  const audios = readApprovedAudios({approved_audios:[{id:AUDIO,title:'Funcionamento',use_when:'Explicação do funcionamento do aplicativo',
    trigger_type:'topic',required:true,enabled:true,mime:'audio/ogg',size_bytes:17,
    storage_path:`${ORG}/agent-audios/${AGENT}/${AUDIO}.ogg`}]});
  expect(await availableConversationAudios(db.pool,ORG,CONV,AGENT,JOB,audios,LAST)).toEqual([]);
});
it('controle: processar isoladamente a preferência antes da pergunta impede áudio', async () => {
  await db.pool.query("update messages set body='Prefiro apenas texto, por favor' where id=$1",[FIRST]);
  const audios = readApprovedAudios({approved_audios:[{id:AUDIO,title:'Funcionamento',use_when:'Explicação do funcionamento do aplicativo',
    trigger_type:'topic',required:true,enabled:true,mime:'audio/ogg',size_bytes:17,
    storage_path:`${ORG}/agent-audios/${AGENT}/${AUDIO}.ogg`}]});
  expect(await availableConversationAudios(db.pool,ORG,CONV,AGENT,JOB,audios,FIRST)).toEqual([]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,direction,body,created_at)
    values($1,$2,$3,$4,'inbound','Como funciona o aplicativo?',now())`, [LAST,ORG,CONV,CONTACT]);
  expect(await availableConversationAudios(db.pool,ORG,CONV,AGENT,JOB,audios,LAST)).toEqual([]);
});
it.each(['text','audio'])('a última preferência explícita da rajada prevalece: %s', async preference => {
  await db.pool.query('update messages set body=$1 where id=$2',
    [preference === 'text' ? 'Quero áudio' : 'Prefiro apenas texto', FIRST]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,created_at,metadata)
    values($1,$2,$3,'inbound',$4,now(),'{"external":"preservado"}')`,
    [LAST,ORG,CONV,preference === 'text' ? 'Prefiro apenas texto' : 'Quero áudio']);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(preference === 'audio');
  expect((await db.pool.query('select metadata from messages where id=$1',[LAST])).rows[0]?.metadata)
    .toMatchObject({external:'preservado',agent_audio_preference:preference});
  // Retentativa não perde a preferência depois de marcar o lote como examinado.
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(preference === 'audio');
});
it('pré-voo detecta pedido de texto absorvido mesmo sem preparar o catálogo primeiro', async () => {
  await db.pool.query("update messages set body='Prefiro apenas texto' where id=$1",[FIRST]);
  await expect(assertConversationAudioAvailable(db.pool,ORG,CONV,AGENT,AUDIO,LAST))
    .rejects.toMatchObject({message:'audio_text_preference'});
});
it('examina histórico maior que um lote sem perder a preferência antiga', async () => {
  await db.pool.query("update messages set body='Prefiro apenas texto' where id=$1",[FIRST]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,created_at)
    select gen_random_uuid(),$1,$2,'inbound','Outra pergunta',now() from generate_series(1,105)`,[ORG,CONV]);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(false);
  expect((await db.pool.query(`select count(*)::integer as n from messages where organization_id=$1
    and conversation_id=$2 and metadata->>'agent_audio_preference_checked'='true'`,[ORG,CONV])).rows[0]?.n).toBe(106);
});
it.each(['workspace','conversation'])('não importa nem modifica preferência de outro %s', async scope => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body)
    values($1,$2,$3,'inbound','Prefiro apenas texto')`,[LAST,scope === 'workspace' ? AGENT : ORG,scope === 'conversation' ? AGENT : CONV]);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(true);
  expect((await db.pool.query('select metadata from messages where id=$1',[LAST])).rows[0]?.metadata).toEqual({});
});

it('assunto inclui pergunta e complemento até a âncora, sem mensagens posteriores', async () => {
  await db.pool.query("update messages set body='Como funciona?' where id=$1", [FIRST]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,created_at)
    values($1,$2,$3,'inbound','Sou pedreiro',now()),($4,$2,$3,'inbound','Agora outra pergunta',now()+interval '1 second')`,
  [LAST,ORG,CONV,EVENT]);
  expect(await pendingAudioSubject(db.pool,ORG,CONV,JOB,LAST)).toBe('Como funciona?\n\nSou pedreiro');
  expect(AUDIO_INTENT_INSTRUCTION).toContain('mudança explícita de assunto posterior prevalece');
});

it.each(['sent','queued','own-job'])('fronteira de assunto considera resposta confirmada de outro turno: %s', async behavior => {
  await db.pool.query("update messages set body='Pergunta antiga' where id=$1", [FIRST]);
  if (behavior === 'own-job') await db.pool.query('insert into send_ledger(id,organization_id,job_id,seq) values($1,$2,$3,3)',[EVENT,ORG,JOB]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,status,body,created_at,metadata)
    values($1,$2,$3,'outbound',$4,'Resposta antiga',now()-interval '1 second',$5)`,
  [EVENT,ORG,CONV,behavior === 'queued' ? 'queued' : 'sent',JSON.stringify(behavior === 'own-job' ? {idempotency_key:EVENT} : {})]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,created_at)
    values($1,$2,$3,'inbound','Qual o preço?',now())`,[LAST,ORG,CONV]);
  expect(await pendingAudioSubject(db.pool,ORG,CONV,JOB,LAST)).toBe(
    behavior === 'sent' ? 'Qual o preço?' : 'Pergunta antiga\n\nQual o preço?');
});

it('inclui transcrição de mídia e não recupera assunto de outro workspace/conversa', async () => {
  await db.pool.query("update messages set body=null,type='audio',media_derived_text='Como funciona?' where id=$1",[FIRST]);
  expect(await pendingAudioSubject(db.pool,ORG,CONV,JOB,FIRST)).toContain('Conteúdo: Como funciona?');
  expect(await pendingAudioSubject(db.pool,AGENT,CONV,JOB,FIRST)).toBe('');
  expect(await pendingAudioSubject(db.pool,ORG,AGENT,JOB,FIRST)).toBe('');
  expect(await pendingAudioSubject(db.pool,ORG,CONV,JOB,null)).toBe('');
});
