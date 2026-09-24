import { randomUUID, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { expireActionIntents, freezeEventPlan, acquireActionIntent } from "@/lib/automation/action-intent";
import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import { queryKiwifyHistory,historyExplanation } from "@/lib/automation/kiwify-history";
import { normalizeKiwify, kiwifyFingerprint } from "@/lib/webhooks/kiwify";
import { DeliveryRejectedError } from "@/lib/channels/delivery-error";
import { applyMetaMessageStatus } from "@/lib/channels/meta/message-status";
import { redriveQueued } from "@/lib/agent-engine/edge/crm/session-reconciler";
import "@/lib/automation/actions/send-whatsapp";

if (process.env.KIWIFY_TEST_NATIVE !== "1" || !process.env.KIWIFY_TEST_POSTGREST) throw new Error("Requires isolated native PostgreSQL/PostgREST harness");
const runtime = vi.hoisted(() => ({ db: null as unknown as pg.Pool, official:false,configured:true,
  endpoint:"", mode:"ok", waitUntil:null as string | null, received:[] as unknown[], openTransactions:[] as number[],
  idleAtSend:[] as Array<Array<{pid:number;application_name:string;query:string;backend_type:string}>>,
  workerTransactions:[] as number[],
  onReceive:null as (()=>Promise<void>) | null,
  send: vi.fn(async (envelope: unknown) => {
    const response=await fetch(runtime.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(envelope)});
    if(!response.ok) throw new DeliveryRejectedError("synthetic_rejected");
    return await response.json() as {externalId:string};
  }), spacing: vi.fn(async () => {}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => runtime.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/automation/throttle", () => ({ checkDailyLimit: async () => ({ allowed:true }), espacarEnvio: () => runtime.spacing() }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => runtime.waitUntil }));
vi.mock("@/lib/channels", () => ({ CHANNEL_SESSION_REF_COLUMNS: "id, provider, waha_session_name", DEFAULT_CHANNEL_PROVIDER: "waha",
  capabilitiesOf: () => ({ freeformOutsideWindow:!runtime.official,requiresTemplates:runtime.official }), resolveSessionRef: (s: unknown) => s,
  getAdapter: () => ({ isConfigured: () => runtime.configured, resolveRecipient: (c: { phoneNumber:string }) => c.phoneNumber,
    send: (envelope: unknown) => runtime.send(envelope), sendTemplate: (envelope: unknown) => runtime.send(envelope), codes: { sendFailed:"provider_send_failed",notConfigured:"waha_not_configured",unknownError:"provider_unknown" } }) }));
// Identifica os backends deste executor sem atribuir a ele as transações de
// outras requisições PostgREST que correm em paralelo no MESMO banco.
const WORKER_APP = "kiwify-automation-worker";
const pool = new pg.Pool({ host:"127.0.0.1",port:Number(process.env.TEST_DB_PORT),user:"postgres",database:"kiwify_test",max:12,application_name:WORKER_APP });
let rest: ChildProcess, proxy: Server, admin: SupabaseClient;
const org=randomUUID(),user=randomUUID();
let integration:string,session:string;
const secret=Buffer.from("synthetic-test");
async function listen(server: Server) { server.listen(0,"127.0.0.1"); await once(server,"listening"); return (server.address() as {port:number}).port; }
beforeAll(async () => {
  runtime.db=pool;
  await pool.query(readFileSync("supabase/migrations/20260921010000_0222_automation_action_identity.sql","utf8"));
  await pool.query(readFileSync("supabase/migrations/20260921030000_0223_automation_event_plan.sql","utf8"));
  await pool.query(readFileSync("supabase/migrations/20260921120000_0224_automation_plan_redaction.sql","utf8"));
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')",[org]);
  await pool.query("insert into auth.users(id,email) values($1,'automation@example.invalid')",[user]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",[user,org]);
  const p=(await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Test','test',1) returning id",[org])).rows[0].id;
  const s=(await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Test','test',1) returning id",[org,p])).rows[0].id;
  const product=(await pool.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,'test','Produto sintético',100) returning id",[org])).rows[0].id;
  integration=(await pool.query("select fn_configure_kiwify($1,$2,$3,$4,$5,$6) id",[org,{name:"Synthetic",store_id:"test",pipeline_id:p,stage_id:s,products:[{external_product_id:"test",product_id:product}]},"c".repeat(64),secret,randomUUID(),user])).rows[0].id;
  session=(await pool.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'WORKING',$3) returning id",[org,randomUUID(),secret])).rows[0].id;
  const probe=createServer();const port=await listen(probe);await new Promise<void>(r=>probe.close(()=>r()));
  const jwtSecret="synthetic-jwt-secret-only-for-isolated-validation";
  rest=spawn(process.env.KIWIFY_TEST_POSTGREST!,[],{stdio:"ignore",windowsHide:true,env:{...process.env,PGRST_DB_URI:`postgresql://postgres@127.0.0.1:${process.env.TEST_DB_PORT}/kiwify_test`,PGRST_DB_SCHEMAS:"public",PGRST_DB_ANON_ROLE:"anon",PGRST_JWT_SECRET:jwtSecret,PGRST_SERVER_HOST:"127.0.0.1",PGRST_SERVER_PORT:String(port),PGRST_LOG_LEVEL:"crit"}});
  await vi.waitFor(async()=>expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true),{timeout:15000});
  proxy=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req) chunks.push(Buffer.from(c));const body=Buffer.concat(chunks);
    if(req.url?.startsWith("/provider")) {
       runtime.received.push(JSON.parse(body.toString("utf8")));
       await runtime.onReceive?.();
       const idle=(await pool.query<{pid:number;application_name:string;query:string;backend_type:string}>(
         "select pid,application_name,query,backend_type from pg_stat_activity where datname=current_database() and state='idle in transaction' order by pid",
       )).rows;
       runtime.idleAtSend.push(idle);
       runtime.openTransactions.push(idle.length);
       runtime.workerTransactions.push(idle.filter(row => row.application_name === WORKER_APP).length);
      if(runtime.mode==="timeout"){res.destroy();return;}
      res.writeHead(runtime.mode==="rejection"?400:200,{"content-type":"application/json"});
      const id=`synthetic-${randomUUID()}`;res.end(JSON.stringify({externalId:id,id}));return;
    }
    const r=await fetch(`http://127.0.0.1:${port}${req.url!.slice(8)}`,{method:req.method,headers:req.headers as Record<string,string>,...(body.length?{body}:{})});
    res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));});
  const gateway=await listen(proxy);
  runtime.endpoint=`http://127.0.0.1:${gateway}/provider`;
  const header=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const claims=Buffer.from(JSON.stringify({role:"service_role",exp:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  const jwt=`${header}.${claims}.${createHmac("sha256",jwtSecret).update(`${header}.${claims}`).digest("base64url")}`;
  admin=createClient(`http://127.0.0.1:${gateway}`,jwt,{auth:{persistSession:false}});
});
afterAll(async()=>{proxy?.closeAllConnections();if(proxy) await new Promise<void>(r=>proxy.close(()=>r()));if(rest && rest.exitCode===null){rest.kill();await once(rest,"exit");}await pool.end();});
let sequence=10;
async function fixture(actions=1) {
  runtime.official=false;
  runtime.configured=true;
  await pool.query("update channel_sessions set status='WORKING' where id=$1",[session]);
  runtime.mode="ok";runtime.waitUntil=null;runtime.received=[];runtime.openTransactions=[];runtime.idleAtSend=[];runtime.workerTransactions=[];runtime.onReceive=null;
  await pool.query("update automation_rules set is_active=false where organization_id=$1",[org]);
  const rule=(await pool.query("insert into automation_rules(organization_id,name,trigger_event,conditions,actions,is_active) values($1,'Compra aprovada','lead.created','[]',$2,true) returning id",[org,JSON.stringify(Array.from({length:actions},()=>({type:"send_whatsapp_message",config:{channel_session_id:session,template:"Olá {{contact.name}}"}})))])).rows[0].id;
  const order=normalizeKiwify({order_id:randomUUID(),webhook_event_type:"order_approved",order_status:"paid",Product:{product_id:"test"},Customer:{full_name:"Cliente sintético",mobile:`+120255501${sequence++}`}});
  const result=(await pool.query("select fn_ingest_kiwify($1,$2,$3,$4,$5,$6) result",[org,integration,order,kiwifyFingerprint(order),randomUUID(),secret])).rows[0].result;
  const receipt=(await pool.query("select * from kiwify_receipts where id=$1",[result.receipt_id])).rows[0];
  const event=(await pool.query("select * from event_log where id=$1",[receipt.event_id])).rows[0];
  const contact=(await pool.query("select contact_id from crm_leads where id=$1",[receipt.lead_id])).rows[0].contact_id;
  runtime.send.mockClear();
  return {rule,event,receipt,contact};
}
it("compra → duas ações distintas; oito workers e retry não repetem transporte",async()=>{
  const f=await fixture(2);
  await Promise.all(Array.from({length:8},()=>runAutomationForEvent(admin,f.event)));
  await runAutomationForEvent(admin,f.event);
  expect(runtime.send).toHaveBeenCalledTimes(2);
  expect(runtime.received).toHaveLength(2);
  // pg_stat_activity global pode ver uma transação PostgREST de OUTRO worker
  // durante um envio. O transporte deste worker não pode carregar transação.
  expect(runtime.workerTransactions, JSON.stringify(runtime.idleAtSend)).toEqual([0,0]);
  const rows=(await pool.query("select * from automation_rule_runs where event_id=$1",[f.event.id])).rows;
  expect(rows).toHaveLength(2);expect(rows.map(r=>r.execution_state)).toEqual(["accepted","accepted"]);
  expect(new Set(rows.map(r=>r.message_id)).size).toBe(2);
});
it("a leitura global inclui outras sessões; o fence mede apenas o pool do executor",async()=>{
  const other=new pg.Client({host:"127.0.0.1",port:Number(process.env.TEST_DB_PORT),user:"postgres",database:"kiwify_test",application_name:"kiwify-unrelated-session"});
  await other.connect();
  try {
    await other.query("begin");
    const {rows}=await pool.query<{app:string;n:number}>(`select application_name app,count(*)::int n from pg_stat_activity
      where datname=current_database() and state='idle in transaction' group by application_name`);
    expect(rows.find(row=>row.app==="kiwify-unrelated-session")?.n).toBe(1);
    expect(rows.find(row=>row.app===WORKER_APP)?.n ?? 0).toBe(0);
    expect(rows.reduce((n,row)=>n+row.n,0)).toBeGreaterThan(0);
  } finally { await other.query("rollback"); await other.end(); }
});
it.each(["timeout","rejection","preflight"])("%s é durável e não reenvia",async(kind)=>{
  const f=await fixture();runtime.mode=kind;
  if(kind==="preflight")runtime.send.mockRejectedValueOnce(new DeliveryRejectedError("meta_session_credentials_missing",false,true));
  await runAutomationForEvent(admin,f.event);await runAutomationForEvent(admin,f.event);
  expect(runtime.send).toHaveBeenCalledTimes(1);
  expect(runtime.received).toHaveLength(kind==="preflight"?0:1);
  expect((await pool.query("select execution_state from automation_rule_runs where event_id=$1",[f.event.id])).rows[0].execution_state).toBe(kind==="timeout"?"uncertain":kind==="preflight"?"failed_before_send":"rejected");
});
it("recusa posterior ao evento bloqueia antes do transporte",async()=>{
  const f=await fixture();await pool.query("update contacts set consent=$2 where id=$1",[f.contact,{marketing:{declined_at:"synthetic-refusal"}}]);
  await runAutomationForEvent(admin,f.event);expect(runtime.send).not.toHaveBeenCalled();
  expect((await pool.query("select execution_state from automation_rule_runs where event_id=$1",[f.event.id])).rows[0].execution_state).toBe("blocked");
});
it("recusa durante o espaçamento também é revalidada no sink",async()=>{
  const f=await fixture();runtime.spacing.mockImplementationOnce(async()=>{await pool.query("update contacts set consent=$2 where id=$1",[f.contact,{marketing:{declined_at:"synthetic-refusal"}}]);});
  await runAutomationForEvent(admin,f.event);expect(runtime.send).not.toHaveBeenCalled();
  expect((await pool.query("select execution_state from automation_rule_runs where event_id=$1",[f.event.id])).rows[0].execution_state).toBe("blocked");
});
it("interrupção em sending vence como incerta sem nova aquisição",async()=>{
  const f=await fixture();await pool.query("insert into automation_rule_runs(organization_id,rule_id,event_id,action_index,status,execution_state,execution_updated_at) values($1,$2,$3,0,'adiado','sending',now()-interval '6 minutes')",[org,f.rule,f.event.id]);
  await expireActionIntents(pool);await runAutomationForEvent(admin,f.event);expect(runtime.send).not.toHaveBeenCalled();
  expect((await pool.query("select execution_state from automation_rule_runs where event_id=$1",[f.event.id])).rows[0].execution_state).toBe("uncertain");
});
it("histórico distingue telefone atual da tentativa e oculta ambos após anonimização",async()=>{
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const q={page:1,limit:20,search:f.receipt.order_id};
  const before=(await queryKiwifyHistory(pool,org,q)).rows[0]!;expect(before.destination_phone).toBe(before.current_phone);expect(before.message_id).toBeTruthy();
  await pool.query("update contacts set phone_number='+12025550199',name='Nome atual sintético',display_name='Nome atual sintético' where id=$1",[f.contact]);
  const changed=(await queryKiwifyHistory(pool,org,q)).rows[0]!;expect(changed.current_phone).not.toBe(changed.destination_phone);
  expect(changed.contact_name).toBe("Nome atual sintético");
  await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1",[f.contact]);
  const anonymized=(await queryKiwifyHistory(pool,org,q)).rows[0]!;
  expect(anonymized.contact_name).toBeNull();expect(anonymized.current_phone).toBeNull();expect(anonymized.destination_phone).toBeNull();
  expect(anonymized.provider_id).toBeNull();expect(anonymized.lead_title).toBeNull();
  expect((await pool.query("select metadata ? 'automation_destination_phone' present from messages where id=$1",[before.message_id])).rows[0].present).toBe(false);
  expect((await queryKiwifyHistory(pool,randomUUID(),q)).rows).toEqual([]);
});
it("consulta sob RLS permite a organização própria e oculta a alheia; não permite apagar intenções",async()=>{
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const client=await pool.connect();
  try {
    await client.query("begin");await client.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    await client.query("set local role authenticated");
    expect((await queryKiwifyHistory(client,org,{page:1,limit:20,search:f.receipt.order_id})).rows).toHaveLength(1);
    expect((await queryKiwifyHistory(client,randomUUID(),{page:1,limit:20,search:""})).rows).toHaveLength(0);
    await expect(client.query("delete from automation_rule_runs where event_id=$1",[f.event.id])).rejects.toMatchObject({code:"42501"});
  } finally { await client.query("rollback");client.release(); }
});
it.each(["valid","absent","invalid","unapproved","text"])("canal oficial: template %s",async(mode)=>{
  const f=await fixture();runtime.official=true;
  const name=`synthetic_${sequence}`;
  if(mode!=="absent" && mode!=="text") await pool.query(`insert into meta_templates
    (organization_id,channel_session_id,waba_id,name,language,status,components,contract_hash)
    values($1,$2,'synthetic',$3,'pt_BR',$4,$5,'synthetic')`,[org,session,name,mode==="unapproved"?"REJECTED":"APPROVED",JSON.stringify([{type:"BODY",text:"Olá {{1}}"}])]);
  if(mode!=="text") await pool.query("update automation_rules set actions=$2 where id=$1",[f.rule,JSON.stringify([{type:"send_whatsapp_message",config:{channel_session_id:session,template_name:name,template_language:"pt_BR",template_values:mode==="invalid"?{}:{"1":"{{contact.name}}"}}}])]);
  await runAutomationForEvent(admin,f.event);
  expect(runtime.send).toHaveBeenCalledTimes(mode==="valid"?1:0);
  const row=(await pool.query("select r.execution_state,coalesce(m.error_code,r.actions_result->0->'detail'->>'reason') as error_code from automation_rule_runs r left join messages m on m.id=r.message_id where r.event_id=$1",[f.event.id])).rows[0];
  expect(row.execution_state).toBe(mode==="valid"?"accepted":"failed_before_send");
  if(mode!=="valid") expect(row.error_code).toBe(({absent:"template_not_found",invalid:"template_missing_values",unapproved:"template_not_approved",text:"messaging_window_closed"} as Record<string,string>)[mode]);
  else expect((await pool.query("select m.body,m.template_name,m.template_language,m.ack from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0])
    .toEqual({body:"Olá Cliente sintético",template_name:name,template_language:"pt_BR",ack:0});
});
it("callbacks repetidos/fora de ordem não regridem; falha após aceite é visível",async()=>{
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const m=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0];
  const channel={id:session,organizationId:org,wabaId:"synthetic",phoneNumberId:"synthetic"};
  const callback=(status:string)=>applyMetaMessageStatus(admin,channel,{kind:"message_status",recipient:null,errorTitle:null,wabaId:"synthetic",externalId:m.external_id,status,occurredAt:new Date().toISOString(),errorCode:null,errorMessage:null});
  await callback("read");await callback("delivered");await callback("sent");await callback("read");
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("read");
  const second=await fixture();await runAutomationForEvent(admin,second.event);
  const message=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[second.event.id])).rows[0];
  await applyMetaMessageStatus(admin,channel,{kind:"message_status",recipient:null,errorTitle:null,wabaId:"synthetic",externalId:message.external_id,status:"failed",occurredAt:new Date().toISOString(),errorCode:131026,errorMessage:"Synthetic rejected"});
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:second.receipt.order_id})).rows[0]?.status).toBe("failed");
});
it("condição não atendida não cria intenção nem mensagem",async()=>{
  const f=await fixture();await pool.query("update automation_rules set conditions=$2 where id=$1",[f.rule,JSON.stringify([{field:"event.product_id",op:"eq",value:randomUUID()}])]);
  await runAutomationForEvent(admin,f.event);expect(runtime.send).not.toHaveBeenCalled();
  expect((await pool.query("select id from automation_rule_runs where event_id=$1",[f.event.id])).rows).toHaveLength(0);
});
it("configuração inválida falha antes da chamada e preserva identificação do cliente",async()=>{
  const f=await fixture();await pool.query("update automation_rules set actions=$2 where id=$1",[f.rule,JSON.stringify([{type:"send_whatsapp_message",config:{channel_session_id:session}}])]);
  const conversation=(await pool.query("insert into conversations(organization_id,contact_id,channel_session_id) values($1,$2,$3) returning id",[org,f.contact,session])).rows[0].id;
  await runAutomationForEvent(admin,f.event);expect(runtime.send).not.toHaveBeenCalled();
  const row=(await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]!;
  expect(row.status).toBe("failed_before_send");expect(row.reason).toBe("invalid_config");expect(row.contact_id).toBe(f.contact);expect(row.lead_id).toBe(f.receipt.lead_id);
  expect(row.conversation_id).toBe(conversation);
});
it("queda da escrita após possível aceite conserva incerteza, sem segunda chamada",async()=>{
  const f=await fixture();
  await pool.query(`create function public.synthetic_refuse_accept() returns trigger language plpgsql as $$ begin
    if new.execution_state='accepted' then raise exception 'synthetic crash after provider';end if;return new;end $$;
    create trigger synthetic_refuse_accept before update on automation_rule_runs for each row execute function public.synthetic_refuse_accept()`);
  try { await runAutomationForEvent(admin,f.event);await runAutomationForEvent(admin,f.event); }
  finally {await pool.query("drop trigger if exists synthetic_refuse_accept on automation_rule_runs; drop function public.synthetic_refuse_accept()");}
  expect(runtime.send).toHaveBeenCalledTimes(1);
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("uncertain");
});
it("filtros e paginação não duplicam a mesma linha; busca aceita nome e telefone atual",async()=>{
  const first=await queryKiwifyHistory(pool,org,{page:1,limit:2,search:""});
  const second=await queryKiwifyHistory(pool,org,{page:2,limit:2,search:""});
  expect(first.has_more).toBe(true);expect(first.rows.map(r=>r.run_id)).not.toEqual(second.rows.map(r=>r.run_id));
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:"",status:"uncertain"})).rows.every(r=>r.status==="uncertain")).toBe(true);
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:"",from:"2000-01-01",to:"2000-01-02"})).rows).toHaveLength(0);
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:"Cliente sintético"})).rows.length).toBeGreaterThan(0);
});
it("watchdog não adota intenção mesmo após metadata apagado; controle legado ainda é alcançável",async()=>{
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const m=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0];
  await pool.query("update messages set status='queued',metadata='{}',created_at=now()-interval '10 minutes' where id=$1",[m.id]);
  await pool.query(`insert into messages(organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,body,sent_via,created_at)
    values($1,$2,$3,$4,'text','outbound','queued','Legacy synthetic','ai',now()-interval '10 minutes')`,[org,m.conversation_id,f.contact,session]);
  runtime.received=[];
  const sent=await redriveQueued(pool,{wahaBaseUrl:runtime.endpoint,wahaApiKey:"synthetic",intervalMs:1,redriveMinAgeMs:1,redriveBatchSize:100,redriveSpacingMs:0},
    {info:vi.fn(),warn:vi.fn(),error:vi.fn()});
  expect(sent).toBe(1);expect(runtime.received).toHaveLength(1);
  expect(runtime.received[0]).toMatchObject({text:"Legacy synthetic"});
  expect((await pool.query("select status from messages where id=$1",[m.id])).rows[0].status).toBe("queued");
});
it("espera pela janela é consultável; recusa tem precedência sobre adiamento",async()=>{
  const f=await fixture();runtime.waitUntil=new Date(Date.now()+86400000).toISOString();
  expect((await runAutomationForEvent(admin,f.event)).status).toBe("retry");
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("pending");
  await pool.query("update contacts set consent=$2 where id=$1",[f.contact,{marketing:{declined_at:"synthetic"}}]);
  await runAutomationForEvent(admin,f.event);
  const row=(await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]!;
  expect(row.status).toBe("blocked");expect(row.reason).toBe("consent_declined");expect(runtime.received).toHaveLength(0);
});
it("ACKs do canal por QR são monotônicos e não inventam leitura para valor desconhecido",async()=>{
  const {dispatchWahaEvent}=await import("@/lib/waha/ingest");
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const m=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0];
  const context={id:session,organization_id:org,is_warmup_complete:null,warmup_started_at:null};
  const callback=(ack:number)=>dispatchWahaEvent(admin as Parameters<typeof dispatchWahaEvent>[0],context,{event:"message.ack",payload:{id:m.external_id,ack}},randomUUID());
  await callback(5);expect((await pool.query("select status from messages where id=$1",[m.id])).rows[0].status).toBe("sent");
  await callback(3);const before=(await pool.query("select status,ack,read_at from messages where id=$1",[m.id])).rows[0];
  await callback(3);await callback(2);await callback(1);
  expect((await pool.query("select status,ack,read_at from messages where id=$1",[m.id])).rows[0]).toEqual(before);
  expect(before.status).toBe("read");
});
it("ACK não cruza sessão; erro após aceite fica visível no histórico",async()=>{
  const {dispatchWahaEvent}=await import("@/lib/waha/ingest");
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const m=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0];
  const context={id:randomUUID(),organization_id:org,is_warmup_complete:null,warmup_started_at:null};
  await dispatchWahaEvent(admin as Parameters<typeof dispatchWahaEvent>[0],context,{event:"message.ack",payload:{id:m.external_id,ack:3}},randomUUID());
  expect((await pool.query("select status from messages where id=$1",[m.id])).rows[0].status).toBe("sent");
  await dispatchWahaEvent(admin as Parameters<typeof dispatchWahaEvent>[0],{...context,id:session},{event:"message.ack",payload:{id:m.external_id,ack:-1}},randomUUID());
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("failed");
});
it.each(["missing_configuration","disconnected"])("canal %s informa o motivo sem transporte",async(mode)=>{
  const f=await fixture();
  if(mode==="missing_configuration")runtime.configured=false;
  else await pool.query("update channel_sessions set status='STOPPED' where id=$1",[session]);
  await runAutomationForEvent(admin,f.event);
  expect(runtime.received).toHaveLength(0);expect(runtime.send).not.toHaveBeenCalled();
  const row=(await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]!;
  expect(historyExplanation(row)).toMatch(mode==="missing_configuration"?/não foi configurada/:/não está disponível/);
});
it.each(["edit","remove","reorder","delete_rule"])("plano conserva as ações após %s entre aquisição e retry",async(change)=>{
  const f=await fixture(2);
  const action=(body:string)=>({type:"send_whatsapp_message",config:{channel_session_id:session,template:body}});
  await pool.query("update automation_rules set actions=$2 where id=$1",[f.rule,JSON.stringify([action("Original A"),action("Original B")])]);
  runtime.spacing.mockImplementationOnce(async()=>{
    if(change==="delete_rule"){await pool.query("delete from automation_rules where id=$1",[f.rule]);return;}
    const next=change==="edit"?[action("Original A"),action("Alterada B")]
      :change==="remove"?[action("Original B")]:[action("Original B"),action("Original A")];
    await pool.query("update automation_rules set actions=$2 where id=$1",[f.rule,JSON.stringify(next)]);
  });
  let interrupted=false;
  runtime.db={query:async(text:string,values?:unknown[])=>{
    if(!interrupted && text.includes("insert into automation_rule_runs") && values?.[3]===1){interrupted=true;throw new Error("synthetic worker interruption");}
    return pool.query(text,values);
  }} as unknown as pg.Pool;
  try {await expect(runAutomationForEvent(admin,f.event)).rejects.toThrow("synthetic worker interruption");}
  finally {runtime.db=pool;}
  await runAutomationForEvent(admin,f.event);
  expect(runtime.received.map(row=>(row as {body:string}).body)).toEqual(["Original A","Original B"]);
  await runAutomationForEvent(admin,f.event);expect(runtime.received).toHaveLength(2);
  const identities=(await pool.query("select rule_identity,rule_id from automation_rule_runs where event_id=$1",[f.event.id])).rows;
  expect(identities.every(r=>r.rule_identity===f.rule)).toBe(true);
  if(change==="delete_rule")expect(identities.every(r=>r.rule_id===null)).toBe(true);
});
it("edição antes da aquisição não substitui o plano já adiado",async()=>{
  const f=await fixture();runtime.waitUntil=new Date(Date.now()+86400000).toISOString();
  await runAutomationForEvent(admin,f.event);
  await pool.query("update automation_rules set actions=$2 where id=$1",[f.rule,JSON.stringify([{type:"send_whatsapp_message",config:{channel_session_id:session,template:"Não planejado"}}])]);
  runtime.waitUntil=null;await runAutomationForEvent(admin,f.event);
  expect(runtime.received).toHaveLength(1);expect(runtime.received[0]).toMatchObject({body:"Olá Cliente sintético"});
});
it("plano é privado e a role de execução não pode reescrevê-lo",async()=>{
  const f=await fixture();await runAutomationForEvent(admin,f.event);
  const db=await pool.connect();
  try {
    for(const role of ["anon","authenticated","service_role"]){
      await db.query("begin");await db.query(`set local role ${role}`);
      if(role!=="service_role")await expect(db.query("select rules from automation_event_plans")).rejects.toMatchObject({code:"42501"});
      else await expect(db.query("update automation_event_plans set rules='[]'")).rejects.toMatchObject({code:"42501"});
      await db.query("rollback");
    }
  }finally{await db.query("rollback");db.release();}
});
it("tentativa ainda ativa ultrapassa o limiar sem transferência de propriedade e aceita resposta tardia",async()=>{
  const f=await fixture();let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  runtime.send.mockImplementationOnce(async(envelope)=>{
    const response=await fetch(runtime.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(envelope)});
    const result=await response.json();await gate;return result;
  });
  const active=runAutomationForEvent(admin,f.event);
  try {
    await vi.waitFor(()=>expect(runtime.received).toHaveLength(1));
    await pool.query("update automation_rule_runs set execution_updated_at=now()-interval '6 minutes' where event_id=$1",[f.event.id]);
    await expireActionIntents(pool);await runAutomationForEvent(admin,f.event);
    expect(runtime.received).toHaveLength(1);
    expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("uncertain");
  }finally{release();await active;}
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("accepted");
  const m=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0];
  await applyMetaMessageStatus(admin,{id:session,organizationId:org,wabaId:"synthetic"},
    {kind:"message_status",recipient:null,errorTitle:null,wabaId:"synthetic",externalId:m.external_id,status:"read",occurredAt:new Date().toISOString(),errorCode:null,errorMessage:null});
  await runAutomationForEvent(admin,f.event);
  expect(runtime.received).toHaveLength(1);
  expect((await queryKiwifyHistory(pool,org,{page:1,limit:20,search:f.receipt.order_id})).rows[0]?.status).toBe("read");
});
it("anonimização elimina texto e parâmetros literais do plano mesmo após excluir a regra",async()=>{
  const f=await fixture();
  const name="Pessoa Sintética Privacidade Plano";
  const phone=(await pool.query("select phone_number from contacts where id=$1",[f.contact])).rows[0].phone_number;
  await pool.query("update automation_rules set actions=$2 where id=$1",[f.rule,JSON.stringify([{type:"send_whatsapp_message",
    config:{channel_session_id:session,template:`Olá ${name}: ${phone}`,template_values:{"1":name,"2":phone}}}])]);
  await runAutomationForEvent(admin,f.event);
  await pool.query("delete from automation_rules where id=$1",[f.rule]);
  await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,$3)",[org,f.contact,randomUUID()]);
  const plan=(await pool.query("select rules from automation_event_plans where organization_id=$1 and event_id=$2",[org,f.event.id])).rows[0];
  expect(JSON.stringify(plan.rules)).not.toContain(name);
  expect(JSON.stringify(plan.rules)).not.toContain(phone);
  expect(plan.rules).toEqual([]);
  runtime.send.mockClear();await runAutomationForEvent(admin,f.event);
  expect(runtime.send).not.toHaveBeenCalled();
});
it("anonimização durante espaçamento bloqueia snapshot em memória sem repersistir plano",async()=>{
  const f=await fixture();
  runtime.spacing.mockImplementationOnce(async()=>{await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,$3)",[org,f.contact,randomUUID()]);});
  await runAutomationForEvent(admin,f.event);await runAutomationForEvent(admin,f.event);
  expect(runtime.send).not.toHaveBeenCalled();
  expect((await pool.query("select rules from automation_event_plans where event_id=$1",[f.event.id])).rows[0].rules).toEqual([]);
});
it("anonimização com chamada ativa não espera rede; resposta tardia não restaura texto nem reenvia",async()=>{
  const f=await fixture();let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  runtime.send.mockImplementationOnce(async(envelope)=>{
    const response=await fetch(runtime.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(envelope)});
    const result=await response.json();await gate;return result;
  });
  const active=runAutomationForEvent(admin,f.event);
  try {
    await vi.waitFor(()=>expect(runtime.received).toHaveLength(1));
    await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,$3)",[org,f.contact,randomUUID()]);
    expect((await pool.query("select rules from automation_event_plans where event_id=$1",[f.event.id])).rows[0].rules).toEqual([]);
    await runAutomationForEvent(admin,f.event);expect(runtime.received).toHaveLength(1);
  } finally {release();await active;}
  const m=(await pool.query("select m.* from messages m join automation_rule_runs r on r.message_id=m.id where r.event_id=$1",[f.event.id])).rows[0];
  expect(m.body).toBe("[redacted]");expect(JSON.stringify(m.metadata)).not.toContain("Cliente sintético");
  expect((await pool.query("select last_message_preview from conversations where id=$1",[m.conversation_id])).rows[0].last_message_preview).toBeNull();
  expect(runtime.openTransactions).toEqual([0]);
  await runAutomationForEvent(admin,f.event);expect(runtime.received).toHaveLength(1);
});
it("webhook externo não repete após anonimização durante a primeira chamada",async()=>{
  const f=await fixture();const config={url:runtime.endpoint};
  await freezeEventPlan(pool,org,f.event.id,[{id:f.rule,actions:[{type:"call_webhook",config}]}]);
  const ctx={admin,organizationId:org,ruleId:f.rule,ruleName:"Synthetic",event:f.event,context:{},requestId:f.event.id};
  const id=await acquireActionIntent(pool,ctx,0,"call_webhook",true);expect(id).toBeTruthy();
  runtime.mode="rejection";
  runtime.onReceive=async()=>{await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,$3)",[org,f.contact,randomUUID()]);};
  const result=await executeCallWebhook({...ctx,actionIntentId:id!},config,{skipUrlCheck:true,retryDelaysMs:[0,0]});
  expect(result).toMatchObject({status:"skipped",detail:{reason:"contact_anonymized"}});
  expect(runtime.received).toHaveLength(1);expect(runtime.openTransactions).toEqual([0]);
});
it("vínculos históricos recuperam o titular via receipt/captura e mensagem mesmo sem regra",async()=>{
  const f=await fixture();
  await pool.query("update event_log set entity_id=null where id=$1",[f.event.id]);
  expect((await pool.query("select fn_automation_plan_subject($1,$2) id",[org,f.event.id])).rows[0].id).toBe(f.contact);
  await pool.query("update event_log set entity_id=$2 where id=$1",[f.event.id,f.receipt.lead_id]);
  await runAutomationForEvent(admin,f.event);
  await pool.query("delete from automation_rules where id=$1",[f.rule]);
  await pool.query("update event_log set entity_id=null where id=$1",[f.event.id]);
  await pool.query("update kiwify_receipts set event_id=null where id=$1",[f.receipt.id]);
  expect((await pool.query("select fn_automation_plan_subject($1,$2) id",[org,f.event.id])).rows[0].id).toBe(f.contact);
  const plan=(await pool.query("select rules,redacted_at from automation_event_plans where event_id=$1",[f.event.id])).rows[0];
  expect(plan.rules).toHaveLength(1);expect(plan.redacted_at).toBeNull();
});
it("vínculos conflitantes não são tratados como órfão nem neutralizados",async()=>{
  const a=await fixture(),b=await fixture();
  await pool.query("update webhook_lead_captures set contact_id=$2 where organization_id=$1 and lead_id=$3",[org,b.contact,a.receipt.lead_id]);
  const rules=[{id:a.rule,actions:[{type:"send_whatsapp_message",config:{template:"Synthetic"}}]}];
  await expect(freezeEventPlan(pool,org,a.event.id,rules)).rejects.toThrow("automation_plan_subject_ambiguous");
  expect((await pool.query("select 1 from automation_event_plans where event_id=$1",[a.event.id])).rows).toEqual([]);
  await pool.query("update webhook_lead_captures set contact_id=$2 where organization_id=$1 and lead_id=$3",[org,a.contact,a.receipt.lead_id]);
  expect(await freezeEventPlan(pool,org,a.event.id,rules)).toEqual(rules);
});
