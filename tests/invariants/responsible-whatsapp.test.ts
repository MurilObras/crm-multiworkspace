import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { openCase, markAwaitingLead, resolveCaseFromHuman } from "@/lib/agent-engine/agent/human-cases";
import { acceptResponsibleReply, readResponsibleSettings, saveResponsibleSettings, saveResponsible, waitingForResponsible, type Responsible } from "@/lib/responsibles/service";
import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { collectResponsibleConsultations } from "@/lib/lgpd/export-collector";
import { pgComoSupabase } from "@/tests/pg-como-supabase";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 6 });
let org: string, other: string, contact: string, conv: string, session: string, agent: string;
let recipients: Responsible[];

async function customer() {
  const c = (await pool.query("insert into contacts(organization_id,name) values($1,'Cliente sintético') returning id", [org])).rows[0]!.id as string;
  const v = (await pool.query("insert into conversations(organization_id,contact_id,channel_session_id,status) values($1,$2,$3,'ai_handling') returning id", [org,c,session])).rows[0]!.id as string;
  return { c,v };
}
async function open(conversation = conv, kind = "consultation") {
  const result = await openCase(pool,{tenantId:org,conversationId:conversation,agentId:agent},{title:"Condição especial",summary:"Cliente perguntou sobre condição comercial.",blocker:"Pode aplicar a condição?",contextSnapshot:{responsible_kind:kind}});
  if (!result.ok) throw new Error(result.error.code);
  const request = (await pool.query("select id from agent_responsible_requests where organization_id=$1 and case_id=$2",[org,result.caseId])).rows[0]?.id as string;
  return {caseId:result.caseId,request};
}
async function reply(request: string, recipient = recipients[0]!, type = "text", text = "Pode contratar nestas condições.") {
  const d = (await pool.query(`select * from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and responsible_id=$3 and purpose='notification'`,[org,request,recipient.id])).rows[0]!;
  const external = randomUUID().replaceAll("-", "");
  const notification = (await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,external_id,body,metadata)
    values($1,$2,$3,$4,'text','outbound','sent',$5,'Consulta sintética','{"responsible_internal":true}') returning id`,[org,d.target_contact_id,d.target_conversation_id,session,external])).rows[0]!.id as string;
  await pool.query("update agent_responsible_deliveries set status='sent',message_id=$3 where organization_id=$1 and id=$2",[org,d.id,notification]);
  const message = (await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,external_id,media_url)
    values($1,$2,$3,$4,$5,'inbound','delivered',$6,$7,$8) returning id`,[org,d.target_contact_id,d.target_conversation_id,session,type,text,randomUUID(),type === "audio" ? "http://localhost/voice.ogg" : null])).rows[0]!.id as string;
  return {org,session,responsible:recipient,message,quoted:external};
}
beforeEach(async () => {
  org=randomUUID(); other=randomUUID(); session=randomUUID(); agent=randomUUID(); const version=randomUUID();
  for (const id of [org,other]) await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Workspace sintético','Workspace sintético')",[id]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2::uuid,$1::text,'WORKING','\\x00')",[session,org]);
  await pool.query("insert into ai_agents(id,organization_id,name,system_prompt,kind) values($1,$2,'Agente sintético','Atenda conforme a base aprovada.','mcp_agent')",[agent,org]);
  await pool.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
    values($1,$2,$3,1,'Atenda conforme a base aprovada.','openai','gpt-4.1-mini',$4,'published')`,[version,org,agent,session]);
  await pool.query("update ai_agents set published_version_id=$3 where organization_id=$1 and id=$2",[org,agent,version]);
  recipients=[];
  for (let n=0;n<2;n++) recipients.push((await pool.query<Responsible>("insert into agent_responsibles(organization_id,name,phone) values($1,$2,$3) returning id,name,phone,enabled",[org,`Responsável ${n+1}`,`+551199999990${n}`])).rows[0]!);
  await saveResponsibleSettings(pool,org,agent,{enabled:true,recipient_ids:recipients.map(r=>r.id),conditions:"Condições especiais"});
  const seeded=await customer(); contact=seeded.c; conv=seeded.v;
});
afterAll(()=>pool.end());

describe("responsável por WhatsApp: transações e isolamento reais",()=>{
  it("duas aberturas concorrentes mantêm um único caso e pedido por conversa",async()=>{
    const data={title:"Confirmação",summary:"Condição comercial",blocker:"Pode aprovar?"};
    const results=await Promise.all([openCase(pool,{tenantId:org,conversationId:conv,agentId:agent},data),openCase(pool,{tenantId:org,conversationId:conv,agentId:agent},data)]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect((await pool.query("select count(*)::int n from agent_responsible_requests where organization_id=$1 and conversation_id=$2",[org,conv])).rows[0]!.n).toBe(1);
  });
  it("número interno permanece fora do atendimento comercial",async()=>{
    const r=await open();const a=await reply(r.request);
    const staff=(await pool.query("select contact_id from messages where organization_id=$1 and id=$2",[org,a.message])).rows[0]!.contact_id;
    expect(await waitingForResponsible(pool,org,staff)).toBe(true);
    expect((await pool.query("select count(*)::int n from job_queue where organization_id=$1 and kind='responsible_reply' and source_event_id=$2",[org,a.message])).rows[0]!.n).toBe(1);
  });
  it("impede trocar responsáveis ou números enquanto existem consultas pendentes",async()=>{
    await open();
    await expect(saveResponsibleSettings(pool,org,agent,{enabled:false,recipient_ids:[],conditions:""})).rejects.toThrow("settings_have_pending_requests");
    await expect(saveResponsible(pool,org,{...recipients[0]!,phone:"+5511888888888"},recipients[0]!.id)).rejects.toThrow("recipient_has_pending_requests");
  });
  it("não habilita outro workspace e rejeita agentes/destinatários de outra organização",async()=>{
    expect(await readResponsibleSettings(pool,other,agent)).toBeNull();
    await expect(saveResponsibleSettings(pool,other,agent,{enabled:true,recipient_ids:[recipients[0]!.id],conditions:""})).rejects.toThrow("agent_not_found");
    await expect(pool.query("insert into agent_responsible_bindings(organization_id,agent_id,responsible_id) values($1,$2,$3)",[other,agent,recipients[0]!.id])).rejects.toMatchObject({code:"23503"});
  });
  it("desligado mantém o comportamento antigo sem pedidos ou pausa",async()=>{
    await saveResponsibleSettings(pool,org,agent,{enabled:false,recipient_ids:[],conditions:""});
    expect((await open()).request).toBeUndefined(); expect(await waitingForResponsible(pool,org,contact)).toBe(false);
    expect((await loadPublishedAgentConfig(pool,org,session))?.casesEnabled).toBe(false);
  });
  it("exige conexão compatível e não injeta a consulta após trocar para outro canal",async()=>{
    await pool.query("update channel_sessions set provider='meta_cloud',meta_phone_number_id=id::text where organization_id=$1 and id=$2",[org,session]);
    await expect(saveResponsibleSettings(pool,org,agent,{enabled:true,recipient_ids:recipients.map(r=>r.id),conditions:""})).rejects.toThrow("responsible_channel_unavailable");
    const config=await loadPublishedAgentConfig(pool,org,session);
    expect(config?.responsibleConsultation).toBe(false);
    expect(config?.systemPrompt).not.toContain("Consulta ao responsável pelo WhatsApp");
  });
  it("ativar pelas configurações entrega instruções e tools de consulta ao agente publicado",async()=>{
    const config=await loadPublishedAgentConfig(pool,org,session);
    expect(config?.casesEnabled).toBe(true); expect(config?.responsibleConsultation).toBe(true);
    expect(config?.systemPrompt).toContain("Condições especiais");
  });
  it("chamado, pausa, aviso ao cliente e jobs de cada responsável nascem juntos",async()=>{
    const r=await open(); expect(r.request).toBeTruthy(); expect(await waitingForResponsible(pool,org,contact)).toBe(true);
    const ds=(await pool.query("select purpose,job_id from agent_responsible_deliveries where organization_id=$1 and request_id=$2",[org,r.request])).rows;
    expect(ds.map(d=>d.purpose).sort()).toEqual(["notification","notification","wait_notice"]); expect(ds.every(d=>d.job_id)).toBe(true);
    await pool.query("select public.fn_start_responsible_request($1,$2)",[org,r.caseId]);
    expect((await pool.query("select count(*)::int n from agent_responsible_deliveries where organization_id=$1 and request_id=$2",[org,r.request])).rows[0]!.n).toBe(3);
  });
  it("primeira resposta vence a corrida entre dois responsáveis, sem duplicar entrega",async()=>{
    const r=await open(); const a=await reply(r.request,recipients[0]); const b=await reply(r.request,recipients[1]);
    expect((await Promise.all([acceptResponsibleReply(pool,a),acceptResponsibleReply(pool,b)])).sort()).toEqual(["accepted","already_answered"]);
    expect((await pool.query("select count(*)::int n from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer'",[org,r.request])).rows[0]!.n).toBe(1);
    expect(await waitingForResponsible(pool,org,contact)).toBe(true);
  });
  it("reentrega do mesmo webhook não cria outra resposta nem outra confirmação",async()=>{
    const r=await open();const a=await reply(r.request);
    expect(await acceptResponsibleReply(pool,a)).toBe("accepted"); expect(await acceptResponsibleReply(pool,a)).toBe("duplicate");
  });
  it("preserva texto exato e registra áudio como fonte de entrega, sem transcrever",async()=>{
    const r=await open(); const a=await reply(r.request,recipients[0],"text","Olá!\n\nCondição confirmada 🙂");
    await acceptResponsibleReply(pool,a);
    expect((await pool.query("select body from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer'",[org,r.request])).rows[0]!.body).toBe("Olá!\n\nCondição confirmada 🙂");
    const next=await customer();const r2=await open(next.v);const b=await reply(r2.request,recipients[0],"audio","");
    expect(await acceptResponsibleReply(pool,b)).toBe("accepted");
    expect((await pool.query("select body,source_message_id from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer'",[org,r2.request])).rows[0]).toMatchObject({body:null,source_message_id:b.message});
  });
  it("aviso errado, falta de citação, conexão diferente e outro workspace não autorizam entrega",async()=>{
    const r=await open();const a=await reply(r.request);
    for(const change of [{quoted:null},{quoted:randomUUID()},{session:randomUUID()},{org:other}]) expect(await acceptResponsibleReply(pool,{...a,...change})).toBe("invalid_reply");
    expect((await pool.query("select status from agent_responsible_requests where organization_id=$1 and id=$2",[org,r.request])).rows[0]!.status).toBe("pending");
  });
  it("não usa o nome do cliente para escolher entre dois casos simultâneos",async()=>{
    const r=await open();const second=await customer();const r2=await open(second.v);
    await acceptResponsibleReply(pool,await reply(r2.request));
    const status=(await pool.query("select id,status from agent_responsible_requests where organization_id=$1 order by created_at",[org])).rows;
    expect(status).toContainEqual({id:r.request,status:"pending"}); expect(status).toContainEqual({id:r2.request,status:"answered"});
  });
  it("desabilitar o responsável impede resposta mesmo com citação válida",async()=>{
    const r=await open();const a=await reply(r.request);
    await pool.query("update agent_responsibles set enabled=false where organization_id=$1 and id=$2",[org,recipients[0]!.id]);
    expect(await acceptResponsibleReply(pool,a)).toBe("invalid_reply");
  });
  it("um número não autorizado não ganha permissão citando um aviso correto",async()=>{
    const r=await open();const a=await reply(r.request);
    const fake=(await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body)
      values($1,$2,$3,$4,'text','inbound','delivered','Tentativa sem autorização') returning id`,[org,contact,conv,session])).rows[0]!.id;
    expect(await acceptResponsibleReply(pool,{...a,message:fake})).toBe("invalid_reply");
    expect((await pool.query("select status from agent_responsible_requests where organization_id=$1 and id=$2",[org,r.request])).rows[0]!.status).toBe("pending");
  });
  it("foto, texto vazio ou texto grande não são encaminhados nesta versão",async()=>{
    for(const [type,text] of [["image",""],["text"," "],["text","a".repeat(4001)]]) {
      const customer2=await customer(); const r=await open(customer2.v);
      expect(await acceptResponsibleReply(pool,await reply(r.request,recipients[0],type,text))).toBe("invalid_reply");
    }
  });
  it("a mensagem interna não emite eventos de lead e não aceita autoria forjada",async()=>{
    const r=await open();const a=await reply(r.request);
    const meta=(await pool.query("select metadata from messages where organization_id=$1 and id=$2",[org,a.message])).rows[0]!.metadata;
    expect(meta.responsible_id).toBe(recipients[0]!.id); expect(meta.responsible_internal).toBe(true);
    expect((await pool.query("select count(*)::int n from event_log where organization_id=$1 and payload->>'message_id'=$2",[org,a.message])).rows[0]!.n).toBe(0);
    const fake=(await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,metadata)
      values($1,$2,$3,$4,'text','inbound','delivered','Texto de cliente',$5) returning metadata`,[org,contact,conv,session,{responsible_id:recipients[0]!.id,responsible_internal:true}])).rows[0]!.metadata;
    expect(fake.responsible_internal).toBeUndefined(); expect(fake.responsible_id).toBeUndefined();
    const outgoing=(await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,metadata)
      values($1,$2,$3,$4,'text','outbound','sent','Mensagem comum',$5) returning id,metadata`,[org,contact,conv,session,{responsible_internal:true,responsible_id:recipients[0]!.id}])).rows[0]!;
    expect(outgoing.metadata.responsible_internal).toBeUndefined();
    expect((await pool.query("select count(*)::int n from event_log where organization_id=$1 and payload->>'message_id'=$2",[org,outgoing.id])).rows[0]!.n).toBeGreaterThan(0);
  });
  it("responder pelas telas invalida a consulta externa e permite continuar o caso",async()=>{
    const r=await open();const a=await reply(r.request);
    const actor=randomUUID();await pool.query("insert into auth.users(id,email) values($1,$2)",[actor,`${actor}@example.test`]);
    await markAwaitingLead(pool,org,r.caseId,actor,"Qual condição o cliente precisa?");
    expect(await waitingForResponsible(pool,org,contact)).toBe(false);
    expect(await acceptResponsibleReply(pool,a)).toBe("already_answered");
    await pool.query("update agent_cases set status='awaiting_human' where organization_id=$1 and id=$2",[org,r.caseId]);
    expect(await waitingForResponsible(pool,org,contact)).toBe(true);
    await resolveCaseFromHuman(pool,org,r.caseId,actor,"Resolvido pelas telas.");
    expect(await waitingForResponsible(pool,org,contact)).toBe(false);
  });
  it("pedido de humano não agenda aviso de consulta e mantém a distinção após escalar",async()=>{
    const r=await open(conv,"handoff");
    expect((await pool.query("select purpose from agent_responsible_deliveries where organization_id=$1 and request_id=$2",[org,r.request])).rows.map(x=>x.purpose)).toEqual(["notification","notification"]);
    await pool.query("update agent_cases set status='escalated' where organization_id=$1 and id=$2",[org,r.caseId]);
    expect(await acceptResponsibleReply(pool,await reply(r.request))).toBe("accepted");
    expect((await pool.query("select kind from agent_responsible_requests where organization_id=$1 and id=$2",[org,r.request])).rows[0]!.kind).toBe("handoff");
  });
  it("anon e authenticated não executam RPCs nem escrevem na outbox",async()=>{
    for(const role of ["anon","authenticated"]) {
      const perms=(await pool.query("select has_function_privilege($1,'public.fn_start_responsible_request(uuid,uuid,text)','execute') as execute,has_table_privilege($1,'public.agent_responsible_requests','insert') as insert",[role])).rows[0]!;
      expect(perms).toEqual({execute:false,insert:false});
    }
  });
  it("RLS das cinco tabelas mostra somente registros do workspace de quem consulta",async()=>{
    const actor=randomUUID();
    await pool.query("insert into auth.users(id,email) values($1,$2)",[actor,`${actor}@example.test`]);
    await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())",[actor,org]);
    await open();
    const staff=(await pool.query("insert into agent_responsibles(organization_id,name,phone) values($1,'Responsável de outra conta','+5511988888800') returning id",[other])).rows[0]!.id;
    const foreignAgent=(await pool.query("insert into ai_agents(organization_id,name,system_prompt,kind) values($1,'Agente de outra conta','Base aprovada','mcp_agent') returning id",[other])).rows[0]!.id;
    await pool.query("insert into agent_responsible_settings(organization_id,agent_id) values($1,$2)",[other,foreignAgent]);
    await pool.query("insert into agent_responsible_bindings(organization_id,agent_id,responsible_id) values($1,$2,$3)",[other,foreignAgent,staff]);
    const foreignSession=(await pool.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'WORKING','\\x00') returning id",[other,randomUUID()])).rows[0]!.id;
    const foreignContact=(await pool.query("insert into contacts(organization_id,name) values($1,'Cliente de outra conta') returning id",[other])).rows[0]!.id;
    const foreignConversation=(await pool.query("insert into conversations(organization_id,contact_id,channel_session_id) values($1,$2,$3) returning id",[other,foreignContact,foreignSession])).rows[0]!.id;
    const foreignCase=(await pool.query("insert into agent_cases(organization_id,conversation_id,agent_id,title,summary,blocker) values($1,$2,$3,'Consulta externa','Contexto externo','Confirmação externa') returning id",[other,foreignConversation,foreignAgent])).rows[0]!.id;
    const foreignRequest=(await pool.query("insert into agent_responsible_requests(organization_id,case_id,conversation_id,contact_id,agent_id,kind) values($1,$2,$3,$4,$5,'consultation') returning id",[other,foreignCase,foreignConversation,foreignContact,foreignAgent])).rows[0]!.id;
    const staffContact=(await pool.query("insert into contacts(organization_id,name,phone_number) values($1,'Responsável externo','+5511988888800') returning id",[other])).rows[0]!.id;
    const staffConversation=(await pool.query("select fn_upsert_wa_conversation($1,$2,$3) as id",[other,staffContact,foreignSession])).rows[0]!.id;
    await pool.query("select fn_queue_responsible_delivery($1,$2,$3,'notification',$4,$5)",[other,foreignRequest,staff,staffConversation,staffContact]);
    const tables=['agent_responsibles','agent_responsible_settings','agent_responsible_bindings','agent_responsible_requests','agent_responsible_deliveries'];
    for(const table of tables) expect((await pool.query(`select count(*)::int n from ${table} where organization_id=$1`,[other])).rows[0]!.n).toBeGreaterThan(0);
    const exported=await collectResponsibleConsultations(pgComoSupabase(pool),org,contact);
    expect(exported.requests).toHaveLength(1); expect(exported.deliveries).toHaveLength(3);
    expect(exported.cases).toHaveLength(1); expect(exported.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported)).not.toContain(foreignRequest);
    expect(JSON.stringify(exported)).not.toContain('+5511988888800');
    expect((await collectResponsibleConsultations(pgComoSupabase(pool),other,contact)).requests).toEqual([]);
    const db=await pool.connect();
    try {
      await db.query("begin"); await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      for(const table of tables) {
        const visible=await db.query(`select organization_id from ${table}`);
        expect(visible.rows.length).toBeGreaterThan(0);
        expect(visible.rows.every(r=>r.organization_id===org)).toBe(true);
        expect((await db.query(`select count(*)::int n from ${table} where organization_id=$1`,[other])).rows[0]!.n).toBe(0);
      }
      const staffTarget=(await db.query("select target_contact_id,target_conversation_id from agent_responsible_deliveries where organization_id=$1 and purpose='notification' limit 1",[org])).rows[0]!;
      const forged=(await db.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,metadata)
        values($1,$2,$3,$4,'text','inbound','delivered','Texto não autenticado pelo canal',$5) returning id,metadata`,[org,staffTarget.target_contact_id,staffTarget.target_conversation_id,session,{responsible_internal:true,responsible_id:recipients[0]!.id}])).rows[0]!;
      expect(forged.metadata.responsible_internal).toBeUndefined();
      const changed=(await db.query("update messages set metadata=$3,body='Tentativa de promover a mensagem por edição' where organization_id=$1 and id=$2 returning metadata",[org,forged.id,{responsible_internal:true,responsible_id:recipients[0]!.id}])).rows[0]!;
      expect(changed.metadata.responsible_internal).toBeUndefined(); expect(changed.metadata.responsible_id).toBeUndefined();
      await expect(db.query("insert into agent_responsibles(organization_id,name,phone) values($1,'Sem acesso','+5511988888801')",[org])).rejects.toMatchObject({code:"42501"});
    } finally { await db.query("rollback"); db.release(); }
  });
  it("o último ponto antes da rede barra bloqueio e disputa com a resposta pelas telas",async()=>{
    const r=await open();await acceptResponsibleReply(pool,await reply(r.request));
    const d=(await pool.query("select * from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer'",[org,r.request])).rows[0]!;
    const message=randomUUID();
    await pool.query("update job_queue set status='running',locked_by='proof' where organization_id=$1 and id=$2",[org,d.job_id]);
    await pool.query("insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash) values($1,$2,$3,$4,1,$5)",[message,org,contact,d.job_id,"0".repeat(64)]);
    await pool.query(`insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,metadata)
      values($1,$2,$3,$4,$5,'text','outbound','queued','Resposta aprovada',$6)`,[message,org,contact,conv,session,{responsible_delivery_id:d.id,responsible_recipient:{phone:null,identity:null,lid:null},outbound_attempt:{phase:"prepared"}}]);
    await pool.query("update contacts set is_blocked=true where organization_id=$1 and id=$2",[org,contact]);
    await expect(pool.query("update messages set status='sending' where organization_id=$1 and id=$2",[org,message])).rejects.toMatchObject({code:"42501"});
    await pool.query("update contacts set is_blocked=false where organization_id=$1 and id=$2",[org,contact]);
    await pool.query("update messages set status='sending' where organization_id=$1 and id=$2",[org,message]);
    await expect(pool.query("update agent_cases set status='resolved' where organization_id=$1 and id=$2",[org,r.caseId])).rejects.toMatchObject({code:"55P03"});
  });
  it("a última barreira não permite redirecionar a resposta a outro cliente da mesma conta",async()=>{
    const r=await open(); await acceptResponsibleReply(pool,await reply(r.request));
    const wrong=await customer();
    const d=(await pool.query("select id,job_id from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer'",[org,r.request])).rows[0]!;
    await pool.query("update agent_responsible_deliveries set target_contact_id=$3,target_conversation_id=$4 where organization_id=$1 and id=$2",[org,d.id,wrong.c,wrong.v]);
    await pool.query("update job_queue set contact_id=$3,status='running',locked_by='proof' where organization_id=$1 and id=$2",[org,d.job_id,wrong.c]);
    const message=randomUUID();
    await pool.query("insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash) values($1,$2,$3,$4,1,$5)",[message,org,wrong.c,d.job_id,'0'.repeat(64)]);
    await pool.query(`insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,metadata)
      values($1,$2,$3,$4,$5,'text','outbound','queued','Não pode alcançar outro cliente',$6)`,[message,org,wrong.c,wrong.v,session,{responsible_delivery_id:d.id,responsible_recipient:{phone:null,identity:null,lid:null}}]);
    await expect(pool.query("update messages set status='sending' where organization_id=$1 and id=$2",[org,message])).rejects.toMatchObject({code:'42501',message:'responsible_customer_mismatch'});
  });
  it("anonimização cancela a consulta e remove as cópias internas e o áudio preparado",async()=>{
    const r=await open();const a=await reply(r.request,recipients[0],"audio","");await acceptResponsibleReply(pool,a);
    const d=(await pool.query("select id from agent_responsible_deliveries where organization_id=$1 and request_id=$2 and purpose='answer'",[org,r.request])).rows[0]!.id;
    const path=`${org}/${conv}/${d}.ogg`;
    await pool.query("update agent_responsible_deliveries set media_storage_path=$3 where organization_id=$1 and id=$2",[org,d,path]);
    await pool.query("update contacts set is_anonymized=true,is_blocked=true,anonymized_at=now() where organization_id=$1 and id=$2",[org,contact]);
    expect((await pool.query("select status from agent_responsible_requests where organization_id=$1 and id=$2",[org,r.request])).rows[0]!.status).toBe("cancelled");
    expect((await pool.query("select body from messages where organization_id=$1 and id=$2",[org,a.message])).rows[0]!.body).toBe("[redacted]");
    expect((await pool.query("select status from storage_redaction_queue where organization_id=$1 and object_path=$2",[org,path])).rows[0]!.status).toBe("pending");
    await pool.query("update storage_redaction_queue set status='deleted' where organization_id=$1 and object_path=$2",[org,path]);
    await pool.query("update agent_responsible_deliveries set media_storage_path=$3 where organization_id=$1 and id=$2",[org,d,path]);
    expect((await pool.query("select status from storage_redaction_queue where organization_id=$1 and object_path=$2",[org,path])).rows[0]!.status).toBe("pending");
  });
  it("anonimização concorrente não inverte os locks de caso, pedido e entrega",async()=>{
    const r=await open();
    const d=(await pool.query("select id from agent_responsible_deliveries where organization_id=$1 and request_id=$2 limit 1",[org,r.request])).rows[0]!.id;
    const a=await pool.connect(),b=await pool.connect();
    try {
      await a.query("begin"); await b.query("begin");
      await a.query("select id from agent_cases where organization_id=$1 and id=$2 for update",[org,r.caseId]);
      await a.query("select id from agent_responsible_requests where organization_id=$1 and id=$2 for update",[org,r.request]);
      const pid=(await b.query("select pg_backend_pid() as id")).rows[0]!.id;
      const redaction=b.query("update contacts set is_anonymized=true,is_blocked=true,anonymized_at=now() where organization_id=$1 and id=$2",[org,contact]).then(()=>null,error=>error);
      let blocked=false;
      for(let n=0;n<50;n++) {
        blocked=(await pool.query("select cardinality(pg_blocking_pids($1))>0 as blocked",[pid])).rows[0]!.blocked;
        if(blocked) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await a.query("update agent_responsible_deliveries set body=body where organization_id=$1 and id=$2",[org,d]);
      await a.query("commit"); expect(await redaction).toBeNull(); await b.query("commit");
    } finally { await a.query("rollback"); await b.query("rollback"); a.release(); b.release(); }
  });
});
