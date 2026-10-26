import {afterAll,afterEach,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {createInboundTurnHandler,JobSettledError} from '@/lib/agent-engine/agent/inbound-turn';
import {createFakeRegistry} from '@/lib/agent-engine/edge/llm/providers';
import {createLogger} from '@/lib/agent-engine/obs/logger';
import {enqueueJob,claimJobs,failJob} from '@/lib/agent-engine/queue/queue';
import {saveDelivery} from '@/lib/agent-engine/agent/response-delivery';
import type {ChannelSendInput} from '@/lib/agent-engine/channel-adapter';
if(!process.env.TEST_DB_CONTAINER)throw Error('Use pnpm test:db com banco descartável');
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:4});afterAll(()=>pool.end());
const createdJobs:string[]=[];
afterEach(async()=>{if(createdJobs.length)await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where id=any($1::uuid[])",[createdJobs.splice(0)]);});
async function fixture() {
  const org = randomUUID(), contact = randomUUID(), session = randomUUID(), conversation = randomUUID(), inbound = randomUUID();
  await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')`, [org]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number,source) values($1,$2,'Teste','+5511999900321','whatsapp')`, [contact, org]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted)
    values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)`, [session, org]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group)
    values($1,$2,$3,$4,'ai_handling',false)`, [conversation, org, contact, session]);
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
    values($1,$2,$3,$4,$5,'text','inbound','delivered','Quero fazer a matrícula','external_device',now())`, [inbound, org, conversation, session, contact]);
  await pool.query(`with v as (insert into playbook_versions(organization_id,layer,content)
    select null,'platform','Assistente de teste. Responda por ferramenta.'
    where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
  const { job } = await enqueueJob(pool, org, { kind: 'inbound_turn', leadId: contact,
    payload: { conversation_id: conversation, contact_id: contact, channel_session_id: session, inbound_message_id: inbound, crm_event_id: randomUUID() } });
  createdJobs.push(job.id);
  const claim = async (worker: string) => {
    const [claimed] = await claimJobs(pool, { workerId: worker, maxConcurrency: 8, jobIds: [job.id] });
    expect(claimed?.id).toBe(job.id);
    return claimed!;
  };
  const retry = async (worker: string) => {
    await failJob(pool, job.id, worker, 'falha de teste');
    await pool.query(`update job_queue set run_after=now() where id=$1`, [job.id]);
  };
  const newer = async () => {
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
      values($1,$2,$3,$4,$5,'text','inbound','delivered','NOVA PERGUNTA','external_device',now()+interval '1 second')`, [randomUUID(), org, conversation, session, contact]);
  };
  return { org, contact, session, conversation, job, claim, retry, newer };
}
const usage={inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}};
function handler(send:(input:ChannelSendInput)=>Promise<unknown>,calls:{model:number},clock=new Date('2026-07-28T18:00:00Z'),conversation?:()=>Array<{type:'tool-call';toolCallId:string;toolName:string;input:string}>){
 return createInboundTurnHandler({crmCfg:{supabase:{} as never},llmCfg:{anthropicApiKey:'fake-test-key'},log:createLogger(),
 registry:createFakeRegistry(async opts=>{if(opts.tools?.length){if(!conversation)throw Error('Não chamar agente nem ferramentas na retomada');return {content:conversation(),finishReason:{unified:'tool-calls',raw:undefined},usage,warnings:[]};}calls.model++;
 return {content:[{type:'text',text:'{"commitments":[],"objections":[],"next_action":null,"rolling_summary":"Fatos confirmados"}'}],finishReason:{unified:'stop',raw:undefined},usage,warnings:[]};}),
 knobs:{historyLimit:20,maxContextTokens:2000,notesIndexMaxTokens:1000,maxSteps:5,queuedRetryDelayMs:1000,breaker:{exactFailureWarn:2,exactFailureBlock:5,sameToolFailureWarn:3,sameToolFailureHalt:8,noProgressWarn:3,noProgressBlock:5}},
 channel:()=>({send}) as never,clock:()=>clock,sleep:async()=>{}});
}
it('retoma partes exatas sem modelo conversador; conserva parte aceita e confirma a pendente',async()=>{
 const f=await fixture();const job=await f.claim('resume');const responseKey=randomUUID();
 const bodies=['Primeira parte aprovada.','Qual gasto você quer usar?'];
 await saveDelivery(pool,job,'resume',{version:1,responseKey,agentId:null,agentVersionId:null,firstSeq:1,body:bodies.join(' '),approvedBody:bodies.join(' '),bubbles:bodies,approved:true,waitUntil:null});
 const sent:string[]=[];const calls={model:0};
 const run=handler(async input=>{
 await input.beforePersist?.();
 const found=await pool.query('select id,crm_message_id from send_ledger where organization_id=$1 and job_id=$2 and seq=$3',[f.org,job.id,input.seq]);
 if(found.rows[0])return {kind:'already_sent',idempotencyKey:found.rows[0].id,messageId:found.rows[0].crm_message_id};
 const key=randomUUID(),mid=randomUUID();sent.push(input.body);
 await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,external_id,body,metadata) values($1,$2,$3,$4,$5,'text','outbound','sent',$8,$6,$7)`,[mid,f.org,f.conversation,f.session,f.contact,input.body,JSON.stringify({idempotency_key:key,response_key:responseKey,response_part_count:2}),'ack-'+mid]);
 await pool.query(`insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,$5,$6,'accepted',$7)`,[key,f.org,f.contact,job.id,input.seq,createHash('sha256').update(input.body).digest('hex'),mid]);return {kind:'sent',idempotencyKey:key,messageId:mid};
 },calls);
 // A primeira parte já foi aceita na execução anterior.
 const key=randomUUID(),mid=randomUUID();
 await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,external_id,body,metadata) values($1,$2,$3,$4,$5,'text','outbound','sent','ack-old',$6,$7)`,[mid,f.org,f.conversation,f.session,f.contact,bodies[0],JSON.stringify({idempotency_key:key,response_key:responseKey,response_part_count:2})]);
 await pool.query(`insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,1,'old','accepted',$5)`,[key,f.org,f.contact,job.id,mid]);
 await run(job,pool,{workerId:'resume'});expect(sent).toEqual([bodies[1]]);expect(calls.model).toBe(1);
 expect((await pool.query('select count(*)::int n from lead_checkpoints where organization_id=$1 and job_id=$2',[f.org,job.id])).rows[0].n).toBe(1);
});
it('espera configurada reagenda sem enviar, sem chamar modelo e sem consumir a tentativa',async()=>{
 const f=await fixture(),job=await f.claim('wait');const calls={model:0};let sends=0;
 await saveDelivery(pool,job,'wait',{version:1,responseKey:randomUUID(),agentId:null,agentVersionId:null,firstSeq:1,body:'Resposta preservada.',bubbles:[],approved:false,waitUntil:'2026-07-28T18:00:25.000Z'});
 await expect(handler(async()=>{sends++;throw Error('Não enviar antes do piso');},calls)(job,pool,{workerId:'wait'})).rejects.toBeInstanceOf(JobSettledError);
 expect(sends).toBe(0);expect(calls.model).toBe(0);
 const row=(await pool.query('select status,attempts,payload from job_queue where id=$1',[job.id])).rows[0];expect(row.status).toBe('pending');expect(row.attempts).toBe(0);expect(row.payload.response_delivery.body).toBe('Resposta preservada.');
});

async function accept(f:Awaited<ReturnType<typeof fixture>>,input:ChannelSendInput){
 await input.beforePersist?.();const key=randomUUID(),mid=randomUUID();
 await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,external_id,body,metadata) values($1,$2,$3,$4,$5,'text','outbound','sent',$8,$6,$7)`,[mid,f.org,f.conversation,f.session,f.contact,input.body,JSON.stringify({idempotency_key:key,response_key:input.responseKey,response_part_count:input.responsePartCount}),'ack-'+mid]);
 await pool.query(`insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,$5,$6,'accepted',$7)`,[key,f.org,f.contact,f.job.id,input.seq,createHash('sha256').update(input.body).digest('hex'),mid]);
 return {kind:'sent',idempotencyKey:key,messageId:mid};
}
it('parte queued preserva o plano e só libera a seguinte na retomada confirmada',async()=>{
 const f=await fixture(),job=await f.claim('queued');const calls={model:0},responseKey=randomUUID();
 const bodies=['Primeira parte aprovada.','Segunda parte aprovada.'];
 await saveDelivery(pool,job,'queued',{version:1,responseKey,agentId:null,agentVersionId:null,firstSeq:1,
  body:bodies.join(' '),approvedBody:bodies.join(' '),bubbles:bodies,approved:true,waitUntil:null});
 const attempted:string[]=[];
 await expect(handler(async input=>{attempted.push(input.body);return {kind:'queued',idempotencyKey:randomUUID(),messageId:null};},calls)
  (job,pool,{workerId:'queued'})).rejects.toBeInstanceOf(JobSettledError);
 expect(attempted).toEqual([bodies[0]]);expect(calls.model).toBe(0);
 const saved=(await pool.query('select status,payload from job_queue where id=$1',[job.id])).rows[0];
 expect(saved.status).toBe('pending');expect(saved.payload.response_delivery.bubbles).toEqual(bodies);
 expect((await pool.query('select count(*)::int n from lead_checkpoints where organization_id=$1 and job_id=$2',[f.org,job.id])).rows[0].n).toBe(0);
 await pool.query('update job_queue set run_after=now() where id=$1',[job.id]);const resumed=await f.claim('queued-resume');
 const confirmed:string[]=[];
 await handler(async input=>{confirmed.push(input.body);return accept(f,input);},calls)(resumed,pool,{workerId:'queued-resume'});
 expect(confirmed).toEqual(bodies);expect(calls.model).toBe(1);
});
it('conserva segunda chamada de envio do mesmo step sem repetir modelo nem mutações',async()=>{
 const f=await fixture(),job=await f.claim('first');let model=0;const calls={model:0};
 const parts=['Funciona com seus registros pelo WhatsApp.','Qual gasto pesa mais na sua obra?'];
 const first=handler(async()=>{throw Error('Banco indisponível antes do transporte');},calls,undefined,()=>{model++;return [
  ...parts.map((body,i)=>({type:'tool-call' as const,toolCallId:'send-'+i,toolName:'send_message',input:JSON.stringify({body})})),
  {type:'tool-call' as const,toolCallId:'mutation',toolName:'update_lead_state',input:JSON.stringify({next_action:'NÃO GRAVAR'})}
 ];});
 await expect(first(job,pool,{workerId:'first'})).rejects.toThrow();expect(model).toBe(1);
 const saved=(await pool.query('select payload from job_queue where id=$1',[job.id])).rows[0].payload.response_delivery;
 expect(saved.body).toBe(parts[0]);expect(saved.following).toEqual([{body:parts[1]}]);
 expect((await pool.query('select next_action from lead_state where organization_id=$1 and contact_id=$2',[f.org,f.contact])).rows[0]?.next_action).not.toBe('NÃO GRAVAR');
 await f.retry('first');const retried=await f.claim('second');const sent:Array<{body:string;seq:number}>=[];
 await handler(async input=>{sent.push({body:input.body,seq:input.seq});return accept(f,input);},calls)(retried,pool,{workerId:'second'});
 expect(sent).toEqual(parts.map((body,i)=>({body,seq:i+1})));expect(model).toBe(1);expect(calls.model).toBe(1);
});
it('grupo já confirmado não é retransmitido; próxima parte mantém sequência seguinte',async()=>{
 const f=await fixture(),job=await f.claim('confirmed');const responseKey=randomUUID();
 await saveDelivery(pool,job,'confirmed',{version:1,responseKey,agentId:null,agentVersionId:null,firstSeq:1,body:'Já entregue',approvedBody:'Já entregue',bubbles:['Já entregue'],approved:true,waitUntil:null,following:[{body:'Pergunta ainda pendente?'}]});
 await accept(f,{tenantId:f.org,leadId:f.contact,jobId:job.id,workerId:'confirmed',seq:1,conversationId:f.conversation,body:'Já entregue',responseKey,responsePartCount:1});
 const sent:Array<{body:string;seq:number}>=[];
 await handler(async input=>{sent.push({body:input.body,seq:input.seq});return accept(f,input);},{model:0})(job,pool,{workerId:'confirmed'});
 expect(sent).toEqual([{body:'Pergunta ainda pendente?',seq:2}]);
});
it('nova pergunta impede retomada da resposta antiga',async()=>{
 const f=await fixture(),job=await f.claim('newer');await saveDelivery(pool,job,'newer',{version:1,responseKey:randomUUID(),agentId:null,agentVersionId:null,firstSeq:1,body:'Resposta antiga',bubbles:[],approved:false,waitUntil:null});
 await f.newer();let sends=0;const calls={model:0};
 try{await handler(async()=>{sends++;throw Error('Não enviar');},calls)(job,pool,{workerId:'newer'});}catch(e){if(!(e instanceof JobSettledError))throw e;}
 expect(sends).toBe(0);expect(calls.model).toBe(0);
});
it('controle humano impede o transporte do plano preservado',async()=>{
 const f=await fixture(),job=await f.claim('human');await saveDelivery(pool,job,'human',{version:1,responseKey:randomUUID(),agentId:null,agentVersionId:null,firstSeq:1,body:'Resposta preservada',bubbles:[],approved:false,waitUntil:null});
 await pool.query('update contacts set force_human=true where organization_id=$1 and id=$2',[f.org,f.contact]);let sends=0;const calls={model:0};
 try{await handler(async()=>{sends++;throw Error('Não enviar');},calls)(job,pool,{workerId:'human'});}catch(e){if(!(e instanceof JobSettledError))throw e;}
 expect(sends).toBe(0);expect(calls.model).toBe(0);
});

it.each([0,40])('piso inclui processamento decorrido (%s segundos) e preserva a resposta na fila',async elapsed=>{
 const f=await fixture();const agent=randomUUID(),version=randomUUID();
 await pool.query(`insert into ai_agents(id,organization_id,name,system_prompt,kind,config) values($1,$2,'Agente temporizado','Atenda ao cliente com clareza','mcp_agent',$3)`,[agent,f.org,JSON.stringify({reply_delay:{enabled:true,min_seconds:20,max_seconds:20}})]);
 await pool.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,max_steps) values($1,$2,$3,1,'Atenda com clareza e objetividade.','anthropic','claude-sonnet-4-6',$4,'published',5)`,[version,f.org,agent,f.session]);
 await pool.query('update ai_agents set published_version_id=$1 where id=$2',[version,agent]);
 await pool.query(`update messages set created_at=now()-($2::int*interval '1 second') where id=$1`,[f.job.payload.inbound_message_id,elapsed]);
 const job=await f.claim('floor');let main=0,sends=0;const calls={model:0};
 const first=handler(async input=>{sends++;return accept(f,input);},calls,undefined,()=>++main===1?[{type:'tool-call',toolCallId:'floor',toolName:'send_message',input:JSON.stringify({body:'Resposta temporizada.'})}]:[]);
 if(elapsed===0) {
  await expect(first(job,pool,{workerId:'floor'})).rejects.toBeInstanceOf(JobSettledError);expect(sends).toBe(0);expect(main).toBe(1);
  const row=(await pool.query('select status,attempts,payload from job_queue where id=$1',[job.id])).rows[0];expect(row).toMatchObject({status:'pending',attempts:0});expect(row.payload.response_delivery.body).toBe('Resposta temporizada.');
  await pool.query('update job_queue set run_after=now() where id=$1',[job.id]);const retry=await f.claim('floor-retry');
  await handler(async input=>{sends++;return accept(f,input);},calls,new Date('2026-07-28T18:00:30Z'))(retry,pool,{workerId:'floor-retry'});
 }else await first(job,pool,{workerId:'floor'});
 expect(sends).toBe(1);expect(main).toBe(elapsed===0?1:2);expect(calls.model).toBe(1);
});

it.each(['audio','image','video','revoked'] as const)('retoma mídia %s com contexto já entregue e confere aprovação atual',async kind=>{
 const f=await fixture(),agent=randomUUID(),version=randomUUID(),id=randomUUID();const type=kind==='revoked'?'video':kind;
 const mime=type==='audio'?'audio/ogg':type==='image'?'image/png':'video/mp4';const ext=type==='audio'?'ogg':type==='image'?'png':'mp4';
 const rule={id,title:'Demonstração aprovada',use_when:'Explica o funcionamento do serviço',send_when:'Quando pedir para conhecer o serviço',trigger_type:'topic',required:false,enabled:true,stage_ids:[],size_bytes:17,mime,storage_path:f.org+'/'+(type==='audio'?'agent-audios':'agent-media')+'/'+agent+'/'+id+'.'+ext,...(type==='audio'?{}:{type})};
 await pool.query(`insert into ai_agents(id,organization_id,name,system_prompt,kind,config) values($1,$2,'Agente de mídia','Atenda com arquivos aprovados','mcp_agent',$3)`,[agent,f.org,JSON.stringify({approved_media:[rule]})]);
 await pool.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,max_steps) values($1,$2,$3,1,'Atenda com clareza e objetividade.','anthropic','claude-sonnet-4-6',$4,'published',5)`,[version,f.org,agent,f.session]);
 await pool.query('update ai_agents set published_version_id=$1 where id=$2',[version,agent]);
 const job=await f.claim('media');job.payload.audio_rule_decision={agent_id:agent,audio_id:id};job.payload.media_catalog_decision=true;
 await pool.query('update job_queue set payload=$2 where id=$1',[job.id,JSON.stringify(job.payload)]);
 await accept(f,{tenantId:f.org,leadId:f.contact,jobId:job.id,workerId:'media',seq:1,conversationId:f.conversation,body:'Conheça o funcionamento.',responseKey:randomUUID(),responsePartCount:1});
 const media=type==='audio'?{type,audio_id:id}:{type,media_id:id};
 await saveDelivery(pool,job,'media',{version:1,responseKey:randomUUID(),agentId:agent,agentVersionId:version,firstSeq:2,body:rule.title,media,bubbles:[rule.title],approvedBody:rule.title,approved:true,waitUntil:null});
 if(kind==='revoked')await pool.query(`update ai_agents set config=jsonb_set(config,'{approved_media,0,enabled}','false') where organization_id=$1 and id=$2`,[f.org,agent]);
 const sent:ChannelSendInput[]=[];const calls={model:0};const run=handler(async input=>{sent.push(input);return accept(f,input);},calls);
 if(kind==='revoked'){await expect(run(job,pool,{workerId:'media'})).rejects.toThrow('response_resume_vetoed');expect(sent).toHaveLength(0);expect(calls.model).toBe(0);}
 else {await run(job,pool,{workerId:'media'});expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({seq:2,body:rule.title,media:{...media,agent_id:agent}});expect(calls.model).toBe(1);}
});

it('nova inbound durante a retomada encerra com descarte seguro, sem consumir retries de envio',async()=>{
 const f=await fixture(),job=await f.claim('race');await saveDelivery(pool,job,'race',{version:1,responseKey:randomUUID(),agentId:null,agentVersionId:null,firstSeq:1,body:'Resposta superada',bubbles:[],approved:false,waitUntil:null});
 const calls={model:0};const run=handler(async input=>{await f.newer();await input.beforePersist?.();throw Error('Não transportar resposta antiga');},calls);
 await expect(run(job,pool,{workerId:'race'})).rejects.toBeInstanceOf(JobSettledError);
 expect((await pool.query('select status from job_queue where id=$1',[job.id])).rows[0].status).toBe('done');expect(calls.model).toBe(0);
});
