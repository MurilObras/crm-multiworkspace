import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import { openCase } from "@/lib/agent-engine/agent/human-cases";
import { saveResponsibleSettings, readResponsibleSettings } from "@/lib/responsibles/service";
import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { reprocessMedia } from "@/lib/messaging/media/reprocess";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:4});
const org=randomUUID(),other=randomUUID(); const db=createPgAdminClient(pool);
let contact:string,enrollment:string,job:string,session:string,conversation:string,message:string;
beforeAll(async()=>{ for(const id of [org,other]) await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Sintético','Sintético')",[id]); });
afterAll(async()=>{await pool.query("delete from organizations where id=any($1::uuid[])",[[org,other]]);await pool.end();});
beforeEach(async()=>{
 contact=(await pool.query("insert into contacts(organization_id,display_name) values($1,'Sintético') returning id",[org])).rows[0]!.id;
 session=(await pool.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'WORKING','\\x00') returning id",[org,randomUUID()])).rows[0]!.id;
 conversation=(await pool.query("insert into conversations(organization_id,contact_id,channel_session_id,status) values($1,$2,$3,'ai_handling') returning id",[org,contact,session])).rows[0]!.id;
 const graph={nodes:[{id:'action',type:'action',label:'Retorno',position:{x:0,y:0},config:{mode:'text',body:'Olá'}},{id:'end',type:'end',label:'Fim',position:{x:0,y:100},config:{outcome:'exhausted'}}],edges:[{id:'edge',source:'action',target:'end',priority:0,condition:{type:'always'}}]};
 const v=(await pool.query("insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id",[org,JSON.stringify(graph)])).rows[0]!.id;
 const p=(await pool.query(`insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config) values($1,$2,'active',$3,'{"kind":"manual","cancel_on_reply":false}') returning id`,[org,randomUUID(),v])).rows[0]!.id;
 enrollment=(await pool.query(`insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,next_eval_at,started_at) values($1,$2,$3,$4,$5,'action',now()-interval '1 minute',now()-interval '1 day') returning id`,[org,p,v,contact,conversation])).rows[0]!.id;
 await pool.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key) values($1,$2,'action','turn_enqueued','{}','action:0')`,[org,enrollment]);
 job=(await pool.query(`insert into job_queue(organization_id,contact_id,kind,status,payload) values($1,$2,'followup_turn','done',$3) returning id`,[org,contact,JSON.stringify({followup_enrollment_id:enrollment,node_id:'action',node_epoch:0,enrollment_action_key:'action:0'})])).rows[0]!.id;
 message=(await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,media_storage_path,media_derived_status) values($1,$2,$3,$4,'inbound','audio','delivered',$5,'failed') returning id`,[org,contact,conversation,session,`${org}/${conversation}/voice.ogg`])).rows[0]!.id;
});
async function ledger(status:string,seq=1){ await pool.query("insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status) values($1,$2,$3,$4,'synthetic-hash',$5)",[org,contact,job,seq,status]); }
async function reconcile(){ return db.reconcileActionDelivery!((await db.loadEnrollmentById(org,enrollment))!,'end'); }
describe("fila real versus confirmação de transporte",()=>{
 it("tarefa encerrada sem ledger não espera 11h nem avança o nó",async()=>{
  expect(await reconcile()).toBe('dead'); expect(await db.loadEnrollmentById(org,enrollment)).toMatchObject({status:'dead',current_node_id:'action'});
 });
 it("pending aguarda run_after sem consumir passos ou orçamento de rechecks",async()=>{
  await pool.query("update job_queue set status='pending',run_after=now()+interval '2 days' where id=$1",[job]);
  expect(await reconcile()).toBe('waiting'); const e=(await db.loadEnrollmentById(org,enrollment))!;
  expect(e.steps_taken).toBe(0);expect(new Date(e.next_eval_at!).getTime()).toBeGreaterThan(Date.now()+86_400_000);
 });
 it("só accepted do job e ocupação exatos permite avanço idempotente",async()=>{
  await ledger('accepted');expect(await reconcile()).toBe('confirmed');
  expect(await db.loadEnrollmentById(org,enrollment)).toMatchObject({current_node_id:'end',steps_taken:1});
  expect(await reconcile()).toBe('missing');
 });
 it.each(['requested','queued'])('transporte %s exige conferência e não é reenviado',async status=>{
  await ledger(status);expect(await reconcile()).toBe('review');expect(await db.loadEnrollmentById(org,enrollment)).toMatchObject({status:'paused_manual',current_node_id:'action'});
 });
 it("job com falha e uma parte entregue exige conferência mesmo se todos os ledgers existentes forem accepted",async()=>{
  await ledger('accepted');await pool.query("update job_queue set status='dead' where id=$1",[job]);expect(await reconcile()).toBe('review');
 });
 it("entrega parcial não é tratada como conclusão",async()=>{await ledger('accepted');await ledger('failed',2);expect(await reconcile()).toBe('review');});
 it("não usa prova de outro node_epoch",async()=>{await ledger('accepted');await pool.query("update job_queue set payload=payload||$2::jsonb where id=$1",[job,JSON.stringify({node_epoch:1})]);expect(await reconcile()).toBe('missing');});
 it("cancelamento esperado não gera alerta de falha",async()=>{
  await pool.query("update job_queue set status='failed',last_error='contact_blocked' where id=$1",[job]);expect(await reconcile()).toBe('cancelled');
  expect((await pool.query("select count(*)::int n from agent_inbox_items where organization_id=$1 and ref_id=$2",[org,enrollment])).rows[0]!.n).toBe(0);
 });
 it("snapshot antigo não desfaz pausa humana",async()=>{
  const e=(await db.loadEnrollmentById(org,enrollment))!; await ledger('accepted');await pool.query("update followup_enrollments set status='paused_manual' where id=$1",[enrollment]);
  expect(await db.reconcileActionDelivery!(e,'end')).toBe('stale');expect((await db.loadEnrollmentById(org,enrollment))!.status).toBe('paused_manual');
 });
 it("nega outra organização e execução por papéis públicos",async()=>{
  const e=(await db.loadEnrollmentById(org,enrollment))!;expect(await db.reconcileActionDelivery!({...e,organization_id:other},'end')).toBe('stale');
  for(const role of ['anon','authenticated']) expect((await pool.query("select has_function_privilege($1,'public.fn_followup_reconcile_action(uuid,uuid,jsonb,text)','execute') allowed",[role])).rows[0]!.allowed).toBe(false);
 });
});
describe("retry de mídia sem resposta antiga",()=>{
 it("enfileira somente derivação e bloqueia repetição concorrente",async()=>{
  const replies=(await pool.query("select count(*)::int n from job_queue where organization_id=$1 and contact_id=$2",[org,contact])).rows[0]!.n;
  expect((await Promise.all([reprocessMedia(pool,org,message),reprocessMedia(pool,org,message)])).filter(r=>r==='queued')).toHaveLength(1);
  expect((await pool.query("select count(*)::int n from event_log where organization_id=$1 and entity_id=$2 and event_type='media.derive_requested'",[org,message])).rows[0]!.n).toBe(1);
  expect((await pool.query("select count(*)::int n from job_queue where organization_id=$1 and contact_id=$2",[org,contact])).rows[0]!.n).toBe(replies);
 });
 it("nega outro workspace e mensagem apagada",async()=>{
  expect(await reprocessMedia(pool,other,message)).toBe('ineligible');await pool.query("update messages set revoked_at=now() where id=$1",[message]);expect(await reprocessMedia(pool,org,message)).toBe('ineligible');
 });
});

it("consulta silenciosa salva os controles sem criar aviso genérico para o cliente",async()=>{
 const agent=randomUUID(),version=randomUUID(),recipient=randomUUID();
 await pool.query("insert into ai_agents(id,organization_id,name,system_prompt,kind) values($1,$2,'Sintético','Base aprovada','mcp_agent')",[agent,org]);
 await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Base aprovada','openai','gpt-4.1-mini',$4,'published')",[version,org,agent,session]);
 await pool.query("update ai_agents set published_version_id=$2 where id=$1",[agent,version]);
 await pool.query("insert into agent_responsibles(id,organization_id,name,phone) values($1,$2,'Equipe sintética','+5511999999999')",[recipient,org]);
 await saveResponsibleSettings(pool,org,agent,{enabled:true,conditions:'Sem informação aprovada',recipient_ids:[recipient],notify_client:false,audio_failures_to_responsible:true});
 expect((await readResponsibleSettings(pool,org,agent))!.settings).toMatchObject({notify_client:false,audio_failures_to_responsible:true});
 const cfg=await loadPublishedAgentConfig(pool,org,session);expect(cfg).toMatchObject({audioFailuresToResponsible:true});expect(cfg!.systemPrompt).toContain("não avise o cliente");
 expect(await openCase(pool,{tenantId:org,conversationId:conversation,agentId:agent},{title:'Conferir áudio',summary:'Falha técnica',blocker:'Ouvir original'})).toMatchObject({ok:true});
 const deliveries=(await pool.query("select purpose from agent_responsible_deliveries d join agent_responsible_requests r on r.organization_id=d.organization_id and r.id=d.request_id where r.organization_id=$1 and r.conversation_id=$2",[org,conversation])).rows;
 expect(deliveries).toEqual([{purpose:'notification'}]);
});
