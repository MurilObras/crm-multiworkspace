import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { reconcileCheckpointNextAction } from '@/lib/agent-engine/agent/lead-state';
import { createInboundTurnHandler } from '@/lib/agent-engine/agent/inbound-turn';
import { createFakeRegistry } from '@/lib/agent-engine/edge/llm/providers';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import { enqueueJob, claimJobs, completeJob } from '@/lib/agent-engine/queue/queue';
import type { ChannelSendInput } from '@/lib/agent-engine/channel-adapter';
import { createHash } from 'node:crypto';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 3 });
const org = randomUUID();
let contact: string;
beforeAll(async () => {
  await pool.query('insert into organizations(id,slug,legal_name,display_name) values($1,$2::text,$2::text,$2::text)', [org, `checkpoint-${org}`]);
  contact = (await pool.query<{ id: string }>('insert into contacts(organization_id,display_name) values($1,$2) returning id', [org, 'Contato sintético'])).rows[0]!.id;
});
afterAll(async () => { await pool.query('delete from organizations where id=$1', [org]); await pool.end(); });

describe('próxima ação do checkpoint contra PostgreSQL real', () => {
  it('o turno real de cancelamento publica checkpoint e próxima ação na mesma conclusão', async () => {
    const c = (await pool.query("insert into contacts(organization_id,display_name,phone_number) values($1,'Teste de cancelamento','+5511999912470') returning id", [org])).rows[0]!.id;
    const s = (await pool.query(`insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted)
      values($1,$2,'WORKING','synthetic') returning id`, [org,randomUUID()])).rows[0]!.id;
    const v = (await pool.query("insert into conversations(organization_id,contact_id,channel_session_id,status) values($1,$2,$3,'ai_handling') returning id", [org,c,s])).rows[0]!.id;
    const m = (await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,sent_at)
      values($1,$2,$3,$4,'text','inbound','delivered','Cancele a aula, sem nova data nem retornos',now()) returning id`, [org,c,v,s])).rows[0]!.id;
    await pool.query("insert into lead_state(organization_id,contact_id,stage,next_action,next_action_seq) values($1,$2,'qualified','Participar da aula cancelada',4)", [org,c]);
    await pool.query(`with v as (insert into playbook_versions(organization_id,layer,content)
      select null,'platform','Assistente sintético de teste.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
      insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
    const memory = { commitments:[],objections:[],next_action:'Aguardar a família; sem retornos',rolling_summary:'A experimental foi cancelada sem nova data.' };
    const usage = { inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0} };
    let steps=0, sends=0;
    const registry=createFakeRegistry(async opts=>{
      const main=(opts.tools?.length??0)>0;const first=main && steps++===0;
      return {content: first ? [{type:'tool-call',toolCallId:'cancel-reply',toolName:'send_message',input:JSON.stringify({body:'A aula está cancelada, sem nova data.'})}]
        : [{type:'text',text:main?'fim':JSON.stringify(memory)}],finishReason:{unified:first?'tool-calls':'stop',raw:undefined},usage,warnings:[]};
    });
    const handler=createInboundTurnHandler({crmCfg:{supabase:{} as never},llmCfg:{anthropicApiKey:'fake-test-key'},registry,log:createLogger(),
      knobs:{historyLimit:20,maxContextTokens:2000,notesIndexMaxTokens:1000,maxSteps:5,queuedRetryDelayMs:1000,
        breaker:{exactFailureWarn:2,exactFailureBlock:5,sameToolFailureWarn:3,sameToolFailureHalt:8,noProgressWarn:3,noProgressBlock:5}},
      clock:()=>new Date('2026-11-10T18:00:00Z'),sleep:async()=>{},channel:()=>({send:async(input:ChannelSendInput)=>{
        sends++;await input.beforePersist?.();const id=randomUUID();
        await pool.query(`insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,sent_via,sent_at)
          values($1,$2,$3,$4,$5,'text','outbound','sent',$6,'ai',now())`,[id,org,c,v,s,input.body]);
        await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
          values($1,$2,$3,$4,$5,'accepted',$6)`,[org,c,input.jobId,input.seq,createHash('sha256').update(input.body).digest('hex'),id]);
        return {kind:'sent',messageId:id,idempotencyKey:id};
      }}) as never});
    const {job}=await enqueueJob(pool,org,{kind:'inbound_turn',leadId:c,payload:{conversation_id:v,contact_id:c,channel_session_id:s,inbound_message_id:m,crm_event_id:randomUUID()}});
    const [claimed]=await claimJobs(pool,{workerId:'cancel-memory-test',maxConcurrency:1});
    expect(claimed?.id).toBe(job.id);
    await handler(claimed!,pool,{workerId:'cancel-memory-test'});
    await completeJob(pool,job.id,'cancel-memory-test');
    expect(sends).toBe(1);
    const checkpoint=(await pool.query('select next_action from lead_checkpoints where organization_id=$1 and contact_id=$2 and job_id=$3',[org,c,job.id])).rows[0]!;
    const state=(await pool.query('select stage,next_action from lead_state where organization_id=$1 and contact_id=$2',[org,c])).rows[0]!;
    expect(state).toEqual({stage:'qualified',next_action:checkpoint.next_action});
    expect(state.next_action).toBe(memory.next_action);
  });
  it('remove a ação cancelada, preserva BANT/estágio e não renova o mesmo texto', async () => {
    await pool.query(`insert into lead_state(organization_id,contact_id,stage,qualification,next_action,next_action_seq)
      values($1,$2,'qualified','{"need":"Experimental"}','Participar da aula cancelada',4)`, [org,contact]);
    await reconcileCheckpointNextAction(pool,org,contact,'Aguardar a família; sem retorno',4);
    const row = (await pool.query('select stage,qualification,next_action,next_action_seq from lead_state where organization_id=$1 and contact_id=$2', [org,contact])).rows[0];
    expect(row).toEqual({ stage:'qualified',qualification:{need:'Experimental'},next_action:'Aguardar a família; sem retorno',next_action_seq:'5' });
    await reconcileCheckpointNextAction(pool,org,contact,'Aguardar a família; sem retorno',5);
    expect((await pool.query('select next_action_seq from lead_state where organization_id=$1 and contact_id=$2', [org,contact])).rows[0]!.next_action_seq).toBe('5');
  });
  it('edição humana posterior vence e o retry antigo não a reverte', async () => {
    await pool.query("update lead_state set next_action='Humano combinou outra ação',next_action_seq=6 where organization_id=$1 and contact_id=$2", [org,contact]);
    await reconcileCheckpointNextAction(pool,org,contact,'Aguardar a família; sem retorno',5);
    expect((await pool.query('select next_action from lead_state where organization_id=$1 and contact_id=$2', [org,contact])).rows[0]!.next_action).toBe('Humano combinou outra ação');
  });
  it('outra organização e marcador legado não alteram a memória', async () => {
    await reconcileCheckpointNextAction(pool,randomUUID(),contact,'Não pode gravar',6);
    await reconcileCheckpointNextAction(pool,org,contact,'Sem CAS não pode gravar',undefined);
    expect((await pool.query('select next_action_seq from lead_state where organization_id=$1 and contact_id=$2', [org,contact])).rows[0]!.next_action_seq).toBe('6');
  });
  it('null explícito limpa a próxima ação e contato anonimizado não é reidratado', async () => {
    await reconcileCheckpointNextAction(pool,org,contact,null,6);
    expect((await pool.query('select next_action from lead_state where organization_id=$1 and contact_id=$2', [org,contact])).rows[0]!.next_action).toBeNull();
    await pool.query('update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2', [org,contact]);
    await reconcileCheckpointNextAction(pool,org,contact,'Não reidratar',7);
    expect((await pool.query('select next_action from lead_state where organization_id=$1 and contact_id=$2', [org,contact])).rows[0]!.next_action).toBeNull();
  });
});
