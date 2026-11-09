// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { caseResolutionHandler } from "@/workers/case-resolution-worker";
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({query: (text:string,values?:unknown[]) => db.query(text,values)}),
}));

// Funções/trigger reais da migration. O baseline integral e a concorrência entre
// conexões ficam no invariante de banco; aqui não há transporte nem clientes reais.
const file = "supabase/migrations/20261109160000_0247_inbox_case_resolution.sql";
const db = new PGlite();
let org: string, other: string, actor: string, contact: string, conv: string, caseId: string, message: string;
beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table organizations(id uuid primary key);
    create table user_organizations(organization_id uuid,user_id uuid,role text,revoked_at timestamptz);
    create function fn_user_org_ids() returns setof uuid language sql as 'select organization_id from user_organizations';
    create function fn_member_role_in_org(p_user uuid,p_org uuid) returns text language sql as
      'select role from user_organizations where user_id=p_user and organization_id=p_org and revoked_at is null';
    create table contacts(id uuid primary key,organization_id uuid,force_human boolean default true,
      is_blocked boolean default false,is_anonymized boolean default false,ai_authorized_at timestamptz,ai_authorized_reason text);
    create table conversations(id uuid primary key,organization_id uuid,contact_id uuid,status text default 'pending',
      assigned_to_user_id uuid,assigned_to_user_name text,assigned_at timestamptz,assignee_kind text,bot_silenced_until timestamptz,
      last_handoff_at timestamptz,last_handoff_reason text,status_changed_at timestamptz,updated_at timestamptz default now());
    create table agent_cases(id uuid primary key,organization_id uuid,conversation_id uuid,status text default 'awaiting_human',
      closed_at timestamptz,updated_at timestamptz);
    create table messages(id uuid primary key,organization_id uuid,conversation_id uuid,contact_id uuid,type text,
      direction text,status text,external_id text,sent_by_user_id uuid,sent_via text,body text,metadata jsonb default '{}',
      media_derived_text text,revoked_at timestamptz,created_at timestamptz default now());
    create table job_queue(id uuid primary key,organization_id uuid,kind text,payload jsonb,created_at timestamptz default now());
    create table agent_responsible_requests(id uuid primary key,organization_id uuid,case_id uuid,contact_id uuid,status text);
    create table agent_responsible_deliveries(id uuid primary key,organization_id uuid,request_id uuid,purpose text,status text);
    create table agent_case_events(id uuid default gen_random_uuid(),organization_id uuid,case_id uuid,kind text,
      actor_kind text,actor_user_id uuid,human_action text,body text,metadata jsonb default '{}',created_at timestamptz default now());
    create table conversation_assignment_events(id uuid default gen_random_uuid(),organization_id uuid,conversation_id uuid,
      from_user_id uuid,to_user_id uuid,changed_by uuid,reason text);
    create table lead_checkpoints(id uuid default gen_random_uuid(),organization_id uuid,contact_id uuid,job_id uuid,
      seq bigint generated always as identity,commitments jsonb default '[]',objections jsonb default '[]',next_action text,rolling_summary text);
    create table event_log(id uuid primary key default gen_random_uuid(),organization_id uuid,event_type text,entity_kind text,
      entity_id uuid,payload jsonb,metadata jsonb);
    create table api_audit_log(id uuid default gen_random_uuid(),organization_id uuid,actor_user_id uuid,action text,
      resource_type text,resource_id uuid,request_id text,metadata jsonb);
    create function emit_event(p_event_type text,p_entity_kind text,p_entity_id uuid,p_payload jsonb default '{}',
      p_metadata jsonb default '{}',p_organization_id uuid default null) returns uuid language plpgsql as $$ declare i uuid; begin
      insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,metadata)
      values(p_organization_id,p_event_type,p_entity_kind,p_entity_id,p_payload,p_metadata) returning id into i; return i; end $$;
  `);
  if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
}, 30_000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec("reset role");
  org=randomUUID(); other=randomUUID(); actor=randomUUID(); contact=randomUUID(); conv=randomUUID(); caseId=randomUUID(); message=randomUUID();
  await db.query("insert into organizations values($1),($2)",[org,other]);
  await db.query("insert into auth.users values($1)",[actor]);
  await db.query("insert into user_organizations values($1,$2,'agent',null)",[org,actor]);
  await db.query("insert into contacts(id,organization_id) values($1,$2)",[contact,org]);
  await db.query("insert into conversations(id,organization_id,contact_id,assignee_kind,bot_silenced_until) values($1,$2,$3,'user','infinity')",[conv,org,contact]);
  await db.query("insert into agent_cases(id,organization_id,conversation_id) values($1,$2,$3)",[caseId,org,conv]);
  await db.query(`insert into messages(id,organization_id,conversation_id,contact_id,type,direction,status,sent_via,sent_by_user_id,body)
    values($1,$2,$3,$4,'text','outbound','queued','user',$5,'Condição confirmada pela equipe.')`,[message,org,conv,contact,actor]);
});
const prepare = async () => (await db.query<{result: Record<string, unknown>}>("select fn_prepare_case_resolution($1,$2,$3,$4) result",[org,message,caseId,actor])).rows[0]!.result;
const apply = async () => (await db.query<{result: Record<string, unknown>}>("select fn_apply_case_resolution($1,$2) result",[org,message])).rows[0]!.result;
const status = async () => (await db.query<{status:string}>("select status from agent_cases where id=$1",[caseId])).rows[0]!.status;
const confirm = async () => db.query("update messages set status='sent',external_id='confirmed-provider-id' where id=$1",[message]);
describe("resolução vinculada a transporte confirmado", () => {
  it("encerrar uma consulta não cancela a resposta humana de outra consulta", async () => {
    const job=randomUUID(), secondCase=randomUUID();
    await db.query("insert into agent_cases(id,organization_id,conversation_id,status) values($1,$2,$3,'resolved')", [secondCase,org,conv]);
    await db.query("insert into job_queue(id,organization_id,kind,payload) values($1,$2,'case_reply_turn',$3)", [job,org,JSON.stringify({case_id:secondCase})]);
    await db.query(`insert into agent_case_events(organization_id,case_id,kind,metadata,created_at)
      values($1,$2,'resolved','{"internal_no_send":true}',now())`, [org,caseId]);
    expect((await db.query<{live:boolean}>("select fn_case_internal_outbound_live($1,$2,$3) live",[org,job,message])).rows[0]!.live).toBe(true);
  });
  it("barreira de transporte rejeita resposta antiga após encerramento interno", async () => {
    const job=randomUUID();
    await db.query("insert into job_queue(id,organization_id,kind,payload) values($1,$2,'inbound_turn','{}')", [job,org]);
    const live=async()=> (await db.query<{live:boolean}>("select fn_case_internal_outbound_live($1,$2,$3) live",[org,job,message])).rows[0]!.live;
    expect(await live()).toBe(true);
    await db.query(`insert into agent_case_events(organization_id,case_id,kind,metadata,created_at)
      values($1,$2,'resolved','{"internal_no_send":true}',now())`, [org,caseId]);
    expect(await live()).toBe(false);
  });
  it("exclusão do autor preserva histórico sem liberar o automático", async () => {
    await prepare(); await confirm();
    await db.query("delete from auth.users where id=$1", [actor]);
    expect((await apply()).status).toBe("cancelled");
    expect(await status()).toBe("awaiting_human");
  });
  it("cria uma intenção durável separada de metadados arbitrários",async()=>{
    expect((await db.query<{name:string|null}>("select to_regclass('public.case_resolution_intents')::text name")).rows[0]!.name).toBe("case_resolution_intents");
  });
  it("fila/falha/incerto não resolvem; confirmação resolve uma vez sem criar resposta",async()=>{
    await prepare(); expect((await apply()).status).toBe("pending"); expect(await status()).toBe("awaiting_human");
    await db.query("update messages set status='failed',metadata='{\"outbound_attempt\":{\"phase\":\"uncertain\"}}' where id=$1",[message]);
    expect((await apply()).status).toBe("pending");
    await confirm(); expect((await apply()).status).toBe("applied"); expect(await status()).toBe("resolved");
    expect((await apply()).status).toBe("applied");
    expect((await db.query<{n:number}>("select count(*)::int n from messages where conversation_id=$1",[conv])).rows[0]!.n).toBe(1);
    expect((await db.query<{n:number}>("select count(*)::int n from agent_case_events where case_id=$1 and kind='resolved'",[caseId])).rows[0]!.n).toBe(1);
  });
  it("decisão humana ABA depois da intenção é preservada",async()=>{
    await prepare(); await db.query("update conversations set bot_silenced_until=null where id=$1",[conv]);
    await db.query("update conversations set bot_silenced_until='infinity' where id=$1",[conv]); await confirm();
    expect(await apply()).toMatchObject({status:"partial",reason:"human_control_changed"});
    expect((await db.query<{force_human:boolean}>("select force_human from contacts where id=$1",[contact])).rows[0]!.force_human).toBe(true);
  });
  it("bloqueio do contato ou outra consulta não liberam o automático",async()=>{
    await prepare(); await db.query("update contacts set is_blocked=true where id=$1",[contact]); await confirm();
    expect(await apply()).toMatchObject({status:"partial",reason:"contact_blocked"});
  });
  it("caso de outro workspace é recusado sem criar intenção",async()=>{
    await expect(db.query("select fn_prepare_case_resolution($1,$2,$3,$4)",[other,message,caseId,actor])).rejects.toThrow();
    expect(await status()).toBe("awaiting_human");
  });
  it("mensagem vinculada não aceita prova, conteúdo ou exclusão forjados pelo navegador",async()=>{
    await prepare();
    await db.exec("grant select,update,delete on messages to authenticated; set role authenticated");
    await expect(confirm()).rejects.toThrow("case_resolution_message_protected");
    await expect(db.query("delete from messages where id=$1",[message])).rejects.toThrow("case_resolution_message_protected");
    await db.exec("reset role");
    await db.query("update messages set body=body where id=$1",[message]);
    expect((await apply()).status).toBe("pending");
  });
  it("confirmação repetida emite um único evento e recuperação não depende da aba",async()=>{
    await prepare(); await confirm(); await confirm();
    const events=await db.query<{n:number}>("select count(*)::int n from event_log where event_type='ai.case_resolution_confirmed' and entity_id=$1",[message]);
    expect(events.rows[0]!.n).toBe(1); expect((await apply()).status).toBe("applied");
  });
  it("resposta externa aceita prevalece e encerramento silencioso não é desfeito",async()=>{
    await prepare(); const req=randomUUID();
    await db.query("insert into agent_responsible_requests values($1,$2,$3,$4,'answered')",[req,org,caseId,contact]);
    await confirm(); expect(await apply()).toMatchObject({status:"confirmed",reason:"responsible_answer_in_flight"});
    await db.query("update agent_cases set status='resolved' where id=$1",[caseId]);
    expect(await apply()).toMatchObject({status:"partial",reason:"case_already_closed"});
  });
  it("início do envio humano impede aceitar outra resposta externa em paralelo",async()=>{
    await prepare(); const req=randomUUID();
    await db.query("insert into agent_responsible_requests values($1,$2,$3,$4,'pending')",[req,org,caseId,contact]);
    expect((await db.query<{live:boolean}>("select fn_case_resolution_transport_live($1,$2) live",[org,message])).rows[0]!.live).toBe(true);
    await expect(db.query("update agent_responsible_requests set status='answered' where id=$1",[req])).rejects.toThrow("inbox_response_in_flight");
  });
  it("a autorização de cruzar o transporte não pode ser consumida duas vezes",async()=>{
    await prepare();
    const live=async()=> (await db.query<{live:boolean}>("select fn_case_resolution_transport_live($1,$2) live",[org,message])).rows[0]!.live;
    expect(await live()).toBe(true); expect(await live()).toBe(false);
  });
  it("dois atendentes não cruzam o transporte para o mesmo caso",async()=>{
    await prepare(); const second=randomUUID();
    await db.query(`insert into messages(id,organization_id,conversation_id,contact_id,type,direction,status,sent_via,sent_by_user_id,body)
      values($1,$2,$3,$4,'text','outbound','queued','user',$5,'Outra resposta')`,[second,org,conv,contact,actor]);
    await db.query("select fn_prepare_case_resolution($1,$2,$3,$4)",[org,second,caseId,actor]);
    const live=async(id:string)=> (await db.query<{live:boolean}>("select fn_case_resolution_transport_live($1,$2) live",[org,id])).rows[0]!.live;
    expect(await live(message)).toBe(true); expect(await live(second)).toBe(false);
  });
  it("metadado preparado não cancela uma rede já iniciada e incerta",async()=>{
    await prepare(); await db.query("select fn_case_resolution_transport_live($1,$2)",[org,message]);
    await db.query("update messages set status='failed',metadata='{\"outbound_attempt\":{\"phase\":\"prepared\"}}' where id=$1",[message]);
    await db.query("select fn_cancel_case_resolution($1,$2)",[org,message]);
    expect((await apply()).status).toBe("pending");
  });
  it("conclusão e replay produzem uma única auditoria atômica",async()=>{
    await prepare(); await confirm(); await apply(); await apply();
    expect((await db.query<{n:number}>("select count(*)::int n from api_audit_log where organization_id=$1 and resource_id=$2",[org,caseId])).rows[0]!.n).toBe(1);
  });
  it("o consumidor recupera confirmação após perda da aba e replay não duplica efeito",async()=>{
    await prepare(); await confirm();
    const event={id:randomUUID(),organization_id:org,event_type:'ai.case_resolution_confirmed',entity_kind:'message',entity_id:message,
      payload:{message_id:message},metadata:{},consumed_by:[],attempts:0};
    expect((await caseResolutionHandler.handle(event)).status).toBe('ok');
    expect((await caseResolutionHandler.handle(event)).status).toBe('ok');
    expect(await status()).toBe('resolved');
    expect((await db.query<{n:number}>("select count(*)::int n from api_audit_log where organization_id=$1 and resource_id=$2",[org,caseId])).rows[0]!.n).toBe(1);
  });
});
