import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pgComoSupabase } from '@/tests/pg-como-supabase';
import { createSupabaseAdminClient, runFollowupTick } from '@/lib/followup/engine';
import { createPgAdminClient, completeTurnForEnrollment } from '@/lib/followup/turn-bridge';
import type { EnrollmentRow } from '@/lib/followup/node-handlers';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 3 });
const org = randomUUID();
beforeAll(async () => { await pool.query('insert into organizations(id,slug,legal_name,display_name) values($1,$2::text,$2::text,$2::text)', [org,org]); });
afterAll(async () => { await pool.query('delete from organizations where id=$1', [org]); await pool.end(); });

it('retoma a espera com plano novo, respeita o novo prazo e cancela sem enviar ao cliente', async () => {
  const contact = (await pool.query('insert into contacts(organization_id,display_name) values($1,$2) returning id', [org,'Teste sintético'])).rows[0]!.id;
  const session = (await pool.query(`insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted)
    values($1,$2,'WORKING','synthetic') returning id`, [org,randomUUID()])).rows[0]!.id;
  const conversation = (await pool.query(`insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at)
    values($1,$2,$3,'ai_handling',now()-interval '3 hours') returning id`, [org,contact,session])).rows[0]!.id;
  const graph = { nodes: [
    {id:'trigger',type:'trigger',config:{}},
    {id:'wait',type:'wait',config:{mode:'smart',min_ms:300_000,max_ms:2_592_000_000}},
    {id:'send',type:'action',config:{mode:'text',body:'Lembrete sintético'}},
    {id:'end',type:'end',config:{outcome:'exhausted'}},
  ].map(node=>({...node,label:node.id,position:{x:0,y:0}})), edges: [ ['trigger','wait'],['wait','send'],['send','end'] ].map(([source,target])=>({id:`${source}-${target}`,source,target,priority:0,condition:{type:'always'}})) };
  const version = (await pool.query('insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id', [org,graph])).rows[0]!.id;
  const pointer = (await pool.query(`insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config)
    values($1,$2,'active',$3,'{"kind":"silence","params":{"threshold_minutes":5},"cancel_on_reply":true}') returning id`, [org,'Lembrete sintético',version])).rows[0]!.id;
  const oldPlan = { decidido_em:new Date(Date.now()-86400000*4).toISOString(),modelo:'teste',esperas:{} };
  const id = (await pool.query(`insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,
    current_node_id,status,outcome,cancel_reason,steps_taken,started_at,completed_at,next_eval_at,timing_plan)
    values($1,$2,$3,$4,$5,'wait','cancelled','replied','cancel_on_reply',4,now()-interval '5 days',now()-interval '4 hours',null,$6) returning id`,
  [org,pointer,version,contact,conversation,oldPlan])).rows[0]!.id;
  await pool.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
    values($1,$2,'wait','wait_started',jsonb_build_object('next_eval_at',now()-interval '1 day'),'wait:3')`, [org,id]);
  await pool.query('select * from fn_enroll_silence_batch($1::jsonb)', [JSON.stringify([{
    organization_id:org,pointer_id:pointer,version_id:version,contact_id:contact,current_node_id:'trigger',next_eval_at:new Date().toISOString(),agent_id:null,
  }])]);
  const row = async () => (await pool.query<{row:EnrollmentRow}>('select row_to_json(e) row from followup_enrollments e where organization_id=$1 and id=$2', [org,id])).rows[0]!.row;
  const resumed = await row();
  expect(resumed.status).toBe('active');
  expect(resumed.steps_taken).toBe(4);
  const enqueued: unknown[] = [];
  const admin = createSupabaseAdminClient(pgComoSupabase(pool));
  const now = new Date();
  const deps = { db:{...admin,claimDueEnrollments:async()=>[await row()]},clock:()=>now,
    enqueueJob:async (job: unknown)=>{enqueued.push(job);} };
  await runFollowupTick(deps);
  expect(enqueued).toEqual([expect.objectContaining({organization_id:org,contact_id:contact,payload:expect.objectContaining({purpose:'plan_timing',node_id:'wait',waits:expect.any(Array)})})]);
  expect((await row()).current_node_id).toBe('wait');
  const job = enqueued[0] as {payload:{enrollment_action_key:string;node_epoch:number}};
  const planned = {kind:'planned' as const,modelo:'teste',propostas:[{node_id:'wait',aguardar_ms:3_600_000,motivo:'Nova data da experimental'}]};
  await completeTurnForEnrollment(createPgAdminClient(pool),org,id,'wait',planned,()=>now,{key:job.payload.enrollment_action_key,nodeEpoch:job.payload.node_epoch});
  const updated = await row();
  expect(updated.current_node_id).toBe('wait');
  expect(Date.parse(updated.next_eval_at!)).toBe(now.getTime()+3_600_000);
  await completeTurnForEnrollment(createPgAdminClient(pool),org,id,'wait',planned,()=>new Date(now.getTime()+1000),{key:job.payload.enrollment_action_key,nodeEpoch:job.payload.node_epoch});
  expect((await row()).next_eval_at).toBe(updated.next_eval_at);
  // A nova resposta cancela a espera e impede o callback antigo de reativá-la.
  await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,sent_at)
    values($1,$2,$3,$4,'text','inbound','received','Cancelar a aula e os lembretes',now())`, [org,contact,conversation,session]);
  await completeTurnForEnrollment(createPgAdminClient(pool),org,id,'wait',planned,()=>now,{key:job.payload.enrollment_action_key,nodeEpoch:job.payload.node_epoch});
  expect((await row()).status).toBe('cancelled');
  expect((await pool.query('select count(*)::int n from messages where organization_id=$1 and direction=\'outbound\'', [org])).rows[0]!.n).toBe(0);
});
