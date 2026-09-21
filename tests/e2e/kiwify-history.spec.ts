import { test,expect } from "@playwright/test";
import { readFileSync,mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Este teste exige explicitamente o rig local já preparado. Não lê .env e
// não executa seeds contra um destino inferido. Não dispara workers/provedores.
const dbUrl=process.env.SUPABASE_DB_URL;
const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL;
function local(value: string | undefined) {
  if(!value) return false;
  return ["localhost","127.0.0.1","[::1]"].includes(new URL(value).hostname);
}
const app=`http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const prefix=`E2E-KIWIFY-${randomUUID().slice(0,8)}`;
let db: pg.Pool;
let creds: {org_id:string;org_slug:string;password:string;supabase_url:string;users:Record<string,{email:string}>};
let pipeline:string,stage:string,product:string,session:string,integration:string,rule:string;
const leadIds:string[]=[],contactIds:string[]=[],conversationIds:string[]=[],messageIds:string[]=[],eventIds:string[]=[];
test.describe("Kiwify: consulta autenticada",()=>{
  test.setTimeout(180000);
  test.beforeAll(async()=>{
    if(!local(dbUrl)||!local(supabaseUrl)) throw new Error("Prepare PostgreSQL e Supabase Auth locais para o E2E Kiwify");
    creds=JSON.parse(readFileSync(".e2e-creds.json","utf8"));
    if(creds.org_slug!=="e2e-test-org"||!local(creds.supabase_url)) throw new Error("Credenciais sintéticas do rig local obrigatórias");
    db=new pg.Pool({connectionString:dbUrl});
    const org=creds.org_id;
    pipeline=(await db.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,$2,$3,1000) returning id",[org,prefix,prefix.toLowerCase()])).rows[0].id;
    stage=(await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Synthetic','synthetic',1000) returning id",[org,pipeline])).rows[0].id;
    product=(await db.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,$2,'Produto sintético',100) returning id",[org,prefix])).rows[0].id;
    session=(await db.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'STOPPED',$3) returning id",[org,prefix,Buffer.from("synthetic-unused")])).rows[0].id;
    integration=(await db.query("insert into kiwify_integrations(organization_id,store_id,name,path_token,secret_encrypted,pipeline_id,stage_id) values($1,$2,$2,$3,$4,$5,$6) returning id",[org,prefix,randomUUID().replaceAll("-","").repeat(2),Buffer.from("synthetic-unused"),pipeline,stage])).rows[0].id;
    rule=(await db.query("insert into automation_rules(organization_id,name,trigger_event,actions,is_active) values($1,$2,'lead.created','[]',false) returning id",[org,prefix])).rows[0].id;
    const states=["accepted","failed_before_send","blocked","uncertain","no_phone"];
    for(let i=0;i<25;i++) {
      const state=states[i%5]!;let contact:string|null=null,conversation:string|null=null;
      if(state!=="no_phone"){
        // Telefone atual ausente é deliberado: o destino da tentativa permanece
        // separado. As alterações de telefone são provadas no teste PostgreSQL.
        contact=(await db.query("insert into contacts(organization_id,name) values($1,$2) returning id",[org,`Cliente sintético ${i}`])).rows[0].id;
        contactIds.push(contact!);
        conversation=(await db.query("insert into conversations(organization_id,contact_id,channel_session_id) values($1,$2,$3) returning id",[org,contact,session])).rows[0].id;
        conversationIds.push(conversation!);
      }
      const lead=(await db.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,source,position_in_stage,custom_fields) values($1,$2,$3,$4,'Compra Kiwify','webhook',$5,$6) returning id",[org,pipeline,stage,contact,(i+1)*1000,{product_id:product}])).rows[0].id;
      leadIds.push(lead);
      // Fixture de histórico, encerrada ANTES de ficar visível ao drain.
      const event=state==="no_phone"?null:(await db.query("insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,status) values($1,'lead.created','crm_lead',$2,'{}','done') returning id",[org,lead])).rows[0].id;
      if(event)eventIds.push(event);
      await db.query("insert into kiwify_receipts(organization_id,integration_id,order_id,event_type,fingerprint,status,external_id,lead_id,event_id) values($1,$2,$3,'order_approved',$4,$5,$6,$7,$8)",[org,integration,`${prefix}-${String(i).padStart(2,"0")}`,"a".repeat(64),state==="no_phone"?"accepted_no_phone":"accepted",`${prefix}:${i}`,lead,event]);
      if(!event)continue;
      const run=randomUUID(),reason=state==="blocked"?"consent_declined":state==="failed_before_send"?"template_not_found":null;
      await db.query("insert into automation_rule_runs(id,organization_id,rule_id,event_id,action_index,status,execution_state,execution_updated_at,actions_result) values($1,$2,$3,$4,0,$5,$6,now(),$7)",[run,org,rule,event,state==="accepted"?"success":"failed",state,JSON.stringify([{type:"send_whatsapp_message",status:state==="accepted"?"success":"failed",detail:{reason}}])]);
      if(state==="blocked")continue;
      await db.query("insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,body,external_id,metadata,sent_via) values($1,$2,$3,$4,$5,'text','outbound',$6,'Conteúdo sintético',$7,$8,'ai')",[run,org,conversation,contact,session,state==="accepted"?"sent":"failed",state==="accepted"?`synthetic-${run}`:null,{outbound_attempt:{phase:state==="uncertain"?"uncertain":state==="accepted"?"started":"prepared"},...(state!=="failed_before_send"?{automation_destination_phone:"+12025550101"}:{})}]);
      messageIds.push(run);await db.query("update automation_rule_runs set message_id=$1 where id=$1",[run]);
    }
    mkdirSync(".superpowers/evidence/kiwify-stage-two",{recursive:true});
  });
  test.afterAll(async()=>{
    if(!db)return;
    try {
      await db.query("delete from automation_rule_runs where event_id=any($1::uuid[])",[eventIds]);
      await db.query("delete from automation_rules where id=$1",[rule]);
      await db.query("delete from messages where id=any($1::uuid[])",[messageIds]);
      await db.query("delete from conversations where id=any($1::uuid[])",[conversationIds]);
      await db.query("delete from kiwify_receipts where integration_id=$1",[integration]);
      await db.query("delete from kiwify_integrations where id=$1",[integration]);
      await db.query("delete from event_log where id=any($1::uuid[]) or entity_id=any($2::uuid[])",[eventIds,messageIds]);
      await db.query("delete from crm_leads where id=any($1::uuid[])",[leadIds]);
      await db.query("delete from contacts where id=any($1::uuid[])",[contactIds]);
      await db.query("delete from crm_stages where id=$1",[stage]);
      await db.query("delete from crm_pipelines where id=$1",[pipeline]);
      await db.query("delete from catalog_products where id=$1",[product]);
      await db.query("delete from channel_sessions where id=$1",[session]);
    }finally{await db.end();}
  });
  test("manager consulta estados, filtros e links; a tela não oferece mutações",async({page})=>{
    await page.goto(`${app}/login`);await page.locator("#email").fill(creds.users.manager!.email);
    await page.locator("#password").fill(creds.password);await page.getByRole("button",{name:/entrar/i}).click();await page.waitForURL(/\/app\//);
    await page.goto(`${app}/app/webhooks`);await page.getByRole("tab",{name:"Kiwify",exact:true}).click();
    const area=page.getByRole("region",{name:"Acompanhamento Kiwify"});
    await area.getByLabel("Compra, nome ou telefone").fill(prefix);
    await expect(area.getByRole("button",{name:"Próxima"})).toBeEnabled();await area.getByRole("button",{name:"Próxima"}).click();await expect(area.getByText("Página 2")).toBeVisible();
    const labels=["Aceita pelo provedor","Falhou antes do envio","Envio bloqueado","Resultado incerto","Compra aceita sem telefone"];
    for(let i=0;i<5;i++){
      await area.getByLabel("Compra, nome ou telefone").fill(`${prefix}-${String(i).padStart(2,"0")}`);
      await expect(area.getByRole("heading",{name:`Compra ${prefix}-${String(i).padStart(2,"0")}`,exact:true})).toBeVisible();
      await expect(area.locator("strong").filter({hasText:labels[i]})).toBeVisible();
      await page.screenshot({path:`.superpowers/evidence/kiwify-stage-two/e2e-auth-${i}.png`,fullPage:true});
      await test.info().attach(`kiwify-${i}`,{path:`.superpowers/evidence/kiwify-stage-two/e2e-auth-${i}.png`,contentType:"image/png"});
    }
    await expect(area.getByRole("button",{name:/reenviar|tentar novamente|cancelar|editar/i})).toHaveCount(0);
    await area.getByLabel("De (UTC)").fill("2000-01-01");await area.getByLabel("Até (UTC)").fill("2000-01-02");
    await expect(area.getByText("Nenhuma compra encontrada para esses filtros.")).toBeVisible();
    await area.getByLabel("De (UTC)").fill("");await area.getByLabel("Até (UTC)").fill("");
    await area.getByLabel("Compra, nome ou telefone").fill(`${prefix}-00`);
    await expect(area.getByRole("link",{name:"Abrir conversa"})).toHaveAttribute("href",`/app/inbox/${conversationIds[0]}`);
    await area.getByRole("link",{name:"Abrir lead",exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`/app/pipelines/${pipeline}\\?lead=${leadIds[0]}`));
  });
  test("viewer não consulta o histórico",async({page})=>{
    await page.goto(`${app}/login`);await page.locator("#email").fill(creds.users.viewer!.email);
    await page.locator("#password").fill(creds.password);await page.getByRole("button",{name:/entrar/i}).click();await page.waitForURL(/\/app\//);
    expect((await page.request.get(`${app}/api/v1/integrations/kiwify/history`)).status()).toBe(403);
  });
});
