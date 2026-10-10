// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { outboundPostgres, ORG, CONTACT, CONV, JOB } from '../helpers/outbound-postgres';
import { isFirstAudioContact, pendingAudioSubject } from '@/lib/agent-engine/agent/audio-rule';
import { conversationAllowsAudio } from '@/lib/agent-engine/agent/conversation-audios';
import { isCurrentInbound } from '@/lib/agent-engine/queue/inbound-pending';
import { discardSupersededOutbound } from '@/lib/agent-engine/edge/crm/discard-superseded-outbound';

const FIRST = '10000000-0000-4000-8000-000000000091';
const LAST = '10000000-0000-4000-8000-000000000092';
const OLD = '10000000-0000-4000-8000-000000000093';
let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
afterAll(async () => db.close());
beforeEach(async () => { await db.seed(); });

it.each(['none', 'confirmed', 'rejected'])('recepção considera apenas atendimento efetivo: %s', async state => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,direction,body,created_at)
    values($1,$2,$3,$4,'inbound','Olá',now())`, [LAST,ORG,CONV,CONTACT]);
  if (state !== 'none') await db.pool.query(`insert into messages
    (id,organization_id,conversation_id,contact_id,direction,body,status,created_at,metadata)
    values($1,$2,$3,$4,'outbound','Resposta obsoleta',$5,now()-interval '1 second',$6)`,
    [OLD,ORG,CONV,CONTACT,state === 'confirmed' ? 'sent' : 'queued',JSON.stringify({
      idempotency_key: OLD,
      outbound_attempt: {phase: state === 'confirmed' ? 'confirmed' : 'prepared', retryable: true},
    })]);
  if (state === 'rejected') {
    await db.pool.query("update job_queue set kind='inbound_turn',status='running',locked_by='review',payload=$1 where id=$2",
      [JSON.stringify({conversation_id:CONV}),JOB]);
    await db.pool.query("insert into send_ledger(id,organization_id,contact_id,job_id,seq,status,crm_message_id) values($1,$2,$3,$4,1,'queued',$1)",
      [OLD,ORG,CONTACT,JOB]);
    await discardSupersededOutbound(db.pool,{organizationId:ORG,contactId:CONTACT,conversationId:CONV,jobId:JOB,workerId:'review'});
    expect((await db.pool.query('select status,error_code,metadata from messages where id=$1',[OLD])).rows[0])
      .toMatchObject({status:'failed',error_code:'inbound_superseded',metadata:{outbound_attempt:{phase:'rejected',retryable:false}}});
  }
  expect(await isFirstAudioContact(db.pool,ORG,CONV,FIRST,LAST)).toBe(state !== 'confirmed');
});

it.each(['body', 'transcript', 'late-transcript'])('recusa de áudio é respeitada no %s', async state => {
  await db.pool.query(`insert into messages
    (id,organization_id,conversation_id,contact_id,direction,type,body,media_derived_text)
    values($1,$2,$3,$4,'inbound',$5,$6,$7)`, [FIRST,ORG,CONV,CONTACT,
      state === 'body' ? 'text' : 'audio', state === 'body' ? 'Prefiro apenas texto' : null,
      state === 'transcript' ? 'Prefiro apenas texto' : null]);
  if (state === 'late-transcript') {
    await conversationAllowsAudio(db.pool,ORG,CONV);
    await db.pool.query("update messages set media_derived_text='Prefiro apenas texto' where id=$1",[FIRST]);
  }
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(false);
});

it.each(['ordered', 'delayed'])('pergunta pendente é mantida com webhook %s', async state => {
  await db.pool.query(`insert into messages
    (id,organization_id,conversation_id,contact_id,direction,type,body,created_at,sent_at)
    values($1,$2,$3,$4,'inbound','text','Sou pedreiro','2026-10-10T12:00:02Z','2026-10-10T12:00:02Z'),
    ($5,$2,$3,$4,'inbound','text','Como funciona?',$6,'2026-10-10T12:00:01Z')`,
    [LAST,ORG,CONV,CONTACT,FIRST,state === 'ordered' ? '2026-10-10T12:00:01Z' : '2026-10-10T12:00:03Z']);
  expect(await isCurrentInbound(db.pool,ORG,CONV,LAST)).toBe(true);
  const subject = await pendingAudioSubject(db.pool,ORG,CONV,JOB,LAST);
  expect(subject).toContain('Como funciona?');
  expect(subject).toContain('Sou pedreiro');
});

it.each(['Quero áudio', 'Como funciona?'])('transcrição corrigida substitui preferência anterior: %s', async corrected => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,type,media_derived_text,metadata)
    values($1,$2,$3,'inbound','audio','Prefiro apenas texto','{"external":"preservado"}')`,[FIRST,ORG,CONV]);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(false);
  await db.pool.query('update messages set media_derived_text=$1 where id=$2',[corrected,FIRST]);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(true);
  const metadata=(await db.pool.query('select metadata from messages where id=$1',[FIRST])).rows[0]!.metadata;
  expect(metadata.external).toBe('preservado');
  expect(metadata.agent_audio_preference).toBe(corrected === 'Quero áudio' ? 'audio' : undefined);
});

it('CAS não grava preferência de uma transcrição substituída durante a leitura', async () => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,type,media_derived_text)
    values($1,$2,$3,'inbound','audio','Quero áudio')`,[FIRST,ORG,CONV]);
  let changed=false;
  const racing={query:async (sql:string,values?:unknown[])=>{
    if(!changed && sql.startsWith('update messages m set metadata=')) {
      changed=true;
      await db.pool.query("update messages set media_derived_text='Prefiro apenas texto' where id=$1",[FIRST]);
    }
    return db.pool.query(sql,values);
  }};
  expect(await conversationAllowsAudio(racing,ORG,CONV)).toBe(false);
  expect(changed).toBe(true);
  expect((await db.pool.query('select metadata from messages where id=$1',[FIRST])).rows[0]!.metadata)
    .toMatchObject({agent_audio_preference:'text',agent_audio_preference_checked:true});
});

it.each(['workspace','conversation'])('não usa transcrição nem marcador de outro %s', async scope => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,type,media_derived_text)
    values($1,$2,$3,'inbound','audio','Prefiro apenas texto')`,[FIRST,scope==='workspace'?OLD:ORG,scope==='conversation'?OLD:CONV]);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(true);
  expect((await db.pool.query('select metadata from messages where id=$1',[FIRST])).rows[0]!.metadata).toEqual({});
});

it.each(['queued','uncertain','started','confirmed','external-id'])('preserva proteção de recepção para saída %s', async state => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,created_at)
    values($1,$2,$3,'inbound',now())`,[LAST,ORG,CONV]);
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,status,external_id,created_at,metadata)
    values($1,$2,$3,'outbound',$4,$5,now()-interval '1 second',$6)`,
    [OLD,ORG,CONV,state==='queued'?'queued':state==='confirmed'?'sent':'failed',state==='external-id'?'ack-real':null,
      JSON.stringify({outbound_attempt:{phase:state==='queued'?'prepared':state==='external-id'?'rejected':state,retryable:false}})]);
  expect(await isFirstAudioContact(db.pool,ORG,CONV,JOB,LAST)).toBe(false);
});

it('preferência mais recente segue sent_at mesmo com chegada fora de ordem', async () => {
  await db.pool.query(`insert into messages(id,organization_id,conversation_id,direction,body,sent_at,created_at)
    values($1,$2,$3,'inbound','Prefiro apenas texto','2026-10-10T12:00:02Z','2026-10-10T12:00:02Z'),
      ($4,$2,$3,'inbound','Quero áudio','2026-10-10T12:00:01Z','2026-10-10T12:00:03Z')`,[LAST,ORG,CONV,FIRST]);
  expect(await conversationAllowsAudio(db.pool,ORG,CONV)).toBe(false);
});
