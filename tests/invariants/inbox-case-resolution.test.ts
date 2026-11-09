import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyCaseResolution, assertCaseResolutionBeforeTransport, prepareCaseResolution, readCaseResolution } from "@/lib/escalacao/resolucao-vinculada";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { resolveCaseFromHuman } from "@/lib/agent-engine/agent/human-cases";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:6});
let org:string, other:string, actor:string, otherActor:string, contact:string, conv:string, session:string, caseId:string, message:string;
beforeEach(async()=>{
  org=randomUUID(); other=randomUUID(); actor=randomUUID(); otherActor=randomUUID(); contact=randomUUID(); conv=randomUUID(); session=randomUUID(); caseId=randomUUID(); message=randomUUID();
  for(const id of [org,other]) await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste isolado','Teste isolado')",[id]);
  for(const [id,tenant] of [[actor,org],[otherActor,other]]) {
    await pool.query("insert into auth.users(id,email) values($1::uuid,$1::text||'@invariant.test')",[id]);
    await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())",[id,tenant]);
  }
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2::uuid,$1::text,'WORKING','\\x00')",[session,org]);
  await pool.query("insert into contacts(id,organization_id,name,force_human) values($1,$2,'Responsável sintético',true)",[contact,org]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status,assigned_to_user_id,assignee_kind,bot_silenced_until) values($1,$2,$3,$4,'claimed',$5,'user','infinity')",[conv,org,contact,session,actor]);
  await pool.query("insert into agent_cases(id,organization_id,conversation_id,title,summary,blocker) values($1,$2,$3,'Condição','Condição aguardando equipe','Confirmar condição')",[caseId,org,conv]);
  await pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,sent_via,sent_by_user_id,body)
    values($1,$2,$3,$4,$5,'text','outbound','queued','user',$6,'Condição confirmada.')`,[message,org,conv,contact,session,actor]);
});
afterAll(()=>pool.end());
const input=()=>({organizationId:org,conversationId:conv,messageId:message,caseId,actorUserId:actor});
const scope=()=>({organizationId:org,messageId:message});
const confirm=()=>pool.query("update messages set status='sent',external_id=$2 where organization_id=$3 and id=$1",[message,`provider-${message}`,org]);
const caseStatus=async()=> (await pool.query<{status:string}>("select status from agent_cases where organization_id=$1 and id=$2",[org,caseId])).rows[0]!.status;

describe("Inbox: confirmação, recuperação e controle humano no Postgres real",()=>{
  it("encerramento interno ganha a corrida contra transporte ainda não iniciado",async()=>{
    const { job } = await enqueueJob(pool,org,{kind:"inbound_turn",leadId:contact,payload:{conversation_id:conv}});
    const closing=await pool.connect();
    try {
      await closing.query("begin"); await closing.query("select id from conversations where id=$1 for update",[conv]);
      const starting=pool.query<{live:boolean}>("select fn_case_internal_outbound_live($1,$2,$3) live",[org,job.id,message]);
      let waiting=false;
      for(let n=0;n<40;n++) {
        const {rows}=await pool.query<{waiting:boolean}>("select exists(select 1 from pg_stat_activity where query like '%select fn_case_internal_outbound_live%' and wait_event_type='Lock') waiting");
        if(rows[0]!.waiting){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      expect(waiting).toBe(true);
      expect(await resolveCaseFromHuman(closing,org,caseId,actor,"Equipe já respondeu.",{internalNoSend:true})).toBe(true);
      await closing.query("commit");
      expect((await starting).rows[0]!.live).toBe(false);
      expect((await pool.query("select metadata from agent_case_events where organization_id=$1 and case_id=$2 and kind='resolved'",[org,caseId])).rows[0]!.metadata).toMatchObject({internal_no_send:true});
    } finally {await closing.query("rollback");closing.release();}
  });
  it("preparação concorrente e replay de confirmação aplicam uma única resolução sem retransporte",async()=>{
    await Promise.all([prepareCaseResolution(pool,input()),prepareCaseResolution(pool,input())]);
    await assertCaseResolutionBeforeTransport(pool,scope()); await confirm();
    const results=await Promise.all([applyCaseResolution(pool,scope()),applyCaseResolution(pool,scope())]);
    expect(results.map(r=>r?.status)).toEqual(["applied","applied"]); expect(await caseStatus()).toBe("resolved");
    const r=await pool.query<{n:number}>("select count(*)::int n from agent_case_events where organization_id=$1 and case_id=$2 and kind='resolved'",[org,caseId]);
    expect(r.rows[0]!.n).toBe(1);
    expect((await pool.query<{n:number}>("select count(*)::int n from messages where organization_id=$1 and conversation_id=$2",[org,conv])).rows[0]!.n).toBe(1);
    expect((await pool.query<{force_human:boolean}>("select force_human from contacts where organization_id=$1 and id=$2",[org,contact])).rows[0]!.force_human).toBe(false);
  });
  it.each(["text","audio"])("%s em fila, falho, sending ou sent sem ID mantém consulta aberta",async(type)=>{
    await pool.query("update messages set type=$2 where id=$1",[message,type]); await prepareCaseResolution(pool,input());
    for(const status of ["queued","failed","sending","sent"]) {
      await pool.query("update messages set status=$2 where id=$1",[message,status]);
      expect((await applyCaseResolution(pool,scope()))?.status).toBe("pending"); expect(await caseStatus()).toBe("awaiting_human");
    }
  });
  it("recibo entregue em áudio aplica a decisão sem inventar transcrição",async()=>{
    await pool.query("update messages set type='audio',body=null where id=$1",[message]); await prepareCaseResolution(pool,input());
    await pool.query("update messages set status='delivered',external_id='audio-proof' where id=$1",[message]);
    expect((await applyCaseResolution(pool,scope()))?.status).toBe("applied");
    const event=(await pool.query<{body:string}>("select body from agent_case_events where case_id=$1 and kind='human_replied'",[caseId])).rows[0]!;
    expect(event.body).toContain("não inventar");
  });
  it("claim/release/claim ABA depois do envio não é apagado pela recuperação",async()=>{
    await prepareCaseResolution(pool,input());
    await pool.query("select fn_conversation_assign($1,$2,null,'release')",[org,conv]);
    await pool.query("select fn_conversation_assign($1,$2,$3,'claim')",[org,conv,actor]); await confirm();
    expect(await applyCaseResolution(pool,scope())).toMatchObject({status:"partial",reason:"human_control_changed"});
    expect((await pool.query<{assigned_to_user_id:string}>("select assigned_to_user_id from conversations where id=$1",[conv])).rows[0]!.assigned_to_user_id).toBe(actor);
  });
  it("outra consulta do mesmo contato preserva pausa mesmo com a selecionada resolvida",async()=>{
    await prepareCaseResolution(pool,input());
    await pool.query("insert into agent_cases(organization_id,conversation_id,title,summary,blocker) values($1,$2,'Outra pendência','Resumo','Decisão')",[org,conv]);
    await confirm(); expect(await applyCaseResolution(pool,scope())).toMatchObject({status:"partial",reason:"pending_consultation"});
    expect(await caseStatus()).toBe("resolved");
  });
  it("opt-out posterior mantém bloqueio e cancela liberação",async()=>{
    await prepareCaseResolution(pool,input()); await pool.query("update contacts set is_blocked=true where id=$1",[contact]); await confirm();
    expect(await applyCaseResolution(pool,scope())).toMatchObject({status:"partial",reason:"contact_blocked"});
  });
  it("IDs cruzados não preparam, confirmam ou recuperam intenção de outro workspace",async()=>{
    await expect(prepareCaseResolution(pool,{...input(),organizationId:other})).rejects.toThrow();
    await expect(prepareCaseResolution(pool,{...input(),actorUserId:otherActor})).rejects.toThrow();
    await prepareCaseResolution(pool,input()); await confirm();
    expect(await applyCaseResolution(pool,{organizationId:other,messageId:message})).toBeNull();
    expect((await readCaseResolution(pool,org,message))?.status).toBe("confirmed"); expect(await caseStatus()).toBe("awaiting_human");
  });
  it("papel autenticado não forja intenção, RPC ou prova de transporte",async()=>{
    await prepareCaseResolution(pool,input()); const client=await pool.connect();
    try {
      await client.query("begin"); await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,role:"authenticated"})]);
      expect((await client.query("select * from case_resolution_intents where message_id=$1",[message])).rows).toHaveLength(1);
      await client.query("savepoint forged_message");
      await expect(client.query("update messages set status='sent',external_id='forged-proof' where id=$1",[message])).rejects.toThrow("case_resolution_message_protected");
      await client.query("rollback to savepoint forged_message");
      await client.query("commit");
      await pool.query("update messages set body=body where id=$1",[message]);
      expect((await readCaseResolution(pool,org,message))?.status).toBe("pending");
      for(const fn of ["fn_apply_case_resolution(uuid,uuid)","fn_case_resolution_transport_live(uuid,uuid)","fn_prepare_case_resolution(uuid,uuid,uuid,uuid)"]) {
        const r=await client.query<{allowed:boolean}>("select has_function_privilege('authenticated',$1,'execute') allowed",[fn]); expect(r.rows[0]!.allowed).toBe(false);
      }
      expect((await client.query<{allowed:boolean}>("select has_table_privilege('authenticated','case_resolution_intents','insert') allowed")).rows[0]!.allowed).toBe(false);
    } finally {await client.query("rollback");client.release();}
  });
  it("duas organizações leem apenas suas intenções; escrita pública e leitura anon são negadas",async()=>{
    await prepareCaseResolution(pool,input());
    const otherSession=randomUUID(), otherContact=randomUUID(), otherConversation=randomUUID(), otherCase=randomUUID(), otherMessage=randomUUID();
    await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2::uuid,$1::text,'STOPPED','\\x00')",[otherSession,other]);
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Outro responsável sintético')",[otherContact,other]);
    await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status,assigned_to_user_id,assignee_kind) values($1,$2,$3,$4,'claimed',$5,'user')",[otherConversation,other,otherContact,otherSession,otherActor]);
    await pool.query("insert into agent_cases(id,organization_id,conversation_id,title,summary,blocker) values($1,$2,$3,'Outra condição','Resumo','Decisão')",[otherCase,other,otherConversation]);
    await pool.query("insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,sent_via,sent_by_user_id,body) values($1,$2,$3,$4,$5,'text','outbound','queued','user',$6,'Resposta sintética.')",[otherMessage,other,otherConversation,otherContact,otherSession,otherActor]);
    await prepareCaseResolution(pool,{organizationId:other,conversationId:otherConversation,messageId:otherMessage,caseId:otherCase,actorUserId:otherActor});
    for (const [user, own, foreign] of [[actor,org,other],[otherActor,other,org]]) {
      const client=await pool.connect();
      try {
        await client.query("begin"); await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role:'authenticated'})]);
        expect((await client.query("select * from case_resolution_intents where organization_id=$1",[own])).rows).toHaveLength(1);
        expect((await client.query("select * from case_resolution_intents where organization_id=$1",[foreign])).rows).toHaveLength(0);
        for (const statement of ["insert into case_resolution_intents select * from case_resolution_intents", "update case_resolution_intents set reason='forged'", "delete from case_resolution_intents"]) {
          await client.query("savepoint forbidden_write");
          await expect(client.query(statement)).rejects.toMatchObject({code:'42501'});
          await client.query("rollback to savepoint forbidden_write");
        }
      } finally { await client.query("rollback"); client.release(); }
    }
    const client=await pool.connect();
    try {
      await client.query("begin"); await client.query("set local role anon");
      await expect(client.query("select * from case_resolution_intents")).rejects.toMatchObject({code:'42501'});
      await client.query("rollback"); await client.query("begin"); await client.query("set local role service_role");
      expect((await client.query("select * from case_resolution_intents where organization_id=any($1::uuid[])",[[org,other]])).rows).toHaveLength(2);
    } finally { await client.query("rollback"); client.release(); }
  });
  it("fechamento interno concorrente prevalece e não cria resposta ou turno",async()=>{
    await prepareCaseResolution(pool,input()); await confirm();
    await pool.query("update agent_cases set status='resolved',closed_at=now() where id=$1",[caseId]);
    expect(await applyCaseResolution(pool,scope())).toMatchObject({status:"partial",reason:"case_already_closed"});
    expect((await pool.query<{n:number}>("select count(*)::int n from job_queue where organization_id=$1 and kind='case_reply_turn'",[org])).rows[0]!.n).toBe(0);
  });
  it("duas intenções humanas concorrentes para o mesmo caso têm um único vencedor antes da rede",async()=>{
    await prepareCaseResolution(pool,input()); const second=randomUUID();
    await pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,sent_via,sent_by_user_id,body)
      values($1,$2,$3,$4,$5,'text','outbound','queued','user',$6,'Resposta concorrente.')`,[second,org,conv,contact,session,actor]);
    await prepareCaseResolution(pool,{...input(),messageId:second});
    const results=await Promise.allSettled([assertCaseResolutionBeforeTransport(pool,scope()),
      assertCaseResolutionBeforeTransport(pool,{...scope(),messageId:second})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await pool.query<{n:number}>("select count(*)::int n from case_resolution_intents where organization_id=$1 and case_id=$2 and transport_started_at is not null",[org,caseId])).rows[0]!.n).toBe(1);
  });
  it("alteração da mensagem enquanto o preparo espera lock é revalidada antes de vincular",async()=>{
    const blocker=await pool.connect(); const editor=await pool.connect();
    try {
      await blocker.query("begin"); await blocker.query("select id from agent_cases where id=$1 for update",[caseId]);
      const preparing=prepareCaseResolution(pool,input()).then(()=>({ok:true}),error=>({ok:false,error}));
      let waiting=false;
      for(let n=0;n<40;n++) {
        const {rows}=await pool.query<{waiting:boolean}>("select exists(select 1 from pg_stat_activity where query like '%fn_prepare_case_resolution%' and wait_event_type='Lock') waiting");
        if(rows[0]!.waiting){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      expect(waiting).toBe(true);
      await editor.query("begin"); await editor.query("set local role authenticated");
      await editor.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,role:'authenticated'})]);
      await editor.query("update messages set sent_by_user_id=$2 where id=$1",[message,otherActor]); await editor.query("commit");
      await blocker.query("commit");
      expect(await preparing).toMatchObject({ok:false});
      expect(await readCaseResolution(pool,org,message)).toBeNull(); expect(await caseStatus()).toBe('awaiting_human');
    } finally {await blocker.query("rollback");await editor.query("rollback");blocker.release();editor.release();}
  });
});
