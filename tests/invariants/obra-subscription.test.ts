import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Execute via harness PostgreSQL descartável");
const connectionString = `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT)}/postgres`;
const pool = new pg.Pool({ connectionString, max: 10 });
const service = new pg.Pool({ connectionString, max: 10, options: "-c role=service_role" });
const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID();
const secret = Buffer.from("synthetic-encrypted-secret");
let source: string, pipeline: string, openStage: string;
let otherPipeline: string, otherStage: string;
let counter = 10;
const checked = new Date(Date.now() - 60_000).toISOString();
const started = new Date(Date.parse(checked) - 96 * 3600_000).toISOString();

async function seed(id: string) {
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')", [id]);
  const p = (await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Assinaturas','assinaturas',1) returning id", [id])).rows[0].id;
  const s = (await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Aberto','aberto',1) returning id", [id,p])).rows[0].id;
  await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position,is_won) values($1,$2,'Acesso ativado','acesso_ativado',2,true)", [id,p]);
  const i = (await pool.query("insert into obra_access_integrations(organization_id,pipeline_id,secret_encrypted,is_active,lifecycle_enabled) values($1,$2,$3,true,true) returning id", [id,p,secret])).rows[0].id;
  return { p,s,i };
}
async function opportunity(id = org, p = pipeline, st = openStage) {
  const phone = `+120255512${counter++}`, email = `test${counter}@example.invalid`;
  const contact = (await pool.query("insert into contacts(organization_id,name,email,phone_number) values($1,'Synthetic',$2,$3) returning id", [id,email,phone])).rows[0].id;
  const lead = (await pool.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Assinatura') returning id", [id,p,st,contact])).rows[0].id;
  return { phone,email,contact,lead };
}
function payload(o: { phone: string; email: string }) {
  return { version: 2, event_type: "subscription_status_checked", event_id: randomUUID(), product_user_id: randomUUID(),
    occurred_at: checked, checked_at: checked, trial_started_at: started, name: "Synthetic", email: o.email, phone: o.phone,
    status_pagamento: "ativo", em_trial: false, access_enabled: true, trial_ends_at: null,
    access_expires_at: new Date(Date.parse(checked) + 30 * 86400_000).toISOString() };
}
async function receive(event: ReturnType<typeof payload>, orgId = org, sourceId = source) {
  return (await service.query("select fn_receive_obra_subscription($1,$2,$3,$4,$5,$6) result",
    [orgId,sourceId,event,"a".repeat(64),[event.phone],secret])).rows[0].result;
}
beforeAll(async () => {
  const a = await seed(org), b = await seed(otherOrg);
  pipeline = a.p; openStage = a.s; source = a.i;
  otherPipeline = b.p; otherStage = b.s;
  await pool.query("insert into auth.users(id,email) values($1,'subscription-actor@example.invalid')", [actor]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())", [actor,org]);
  // Controles positivos dos dois tenants antes de testar a negação.
  await receive(payload(await opportunity()));
  await receive(payload(await opportunity(otherOrg,b.p,b.s)),otherOrg,b.i);
  for (const [tenant,cfg,p,st] of [[org,a.i,a.p,a.s],[otherOrg,b.i,b.p,b.s]]) {
    const channel = (await pool.query("insert into channel_sessions(organization_id,waha_session_name,webhook_secret_encrypted,provider) values($1,$2,$3,'waha') returning id",[tenant,`synthetic-${randomUUID()}`,secret])).rows[0].id;
    await service.query("select fn_configure_obra_outreach($1,$2,true,$3,null,'Cadastro','Uso','Confirmada')",[tenant,cfg,channel]);
    await receive(payload(await opportunity(tenant,p,st)),tenant,cfg);
    await service.query("select fn_configure_obra_outreach($1,$2,false,$3,null,'Cadastro','Uso','Confirmada')",[tenant,cfg,channel]);
  }
});
afterAll(async () => { await service.end(); await pool.end(); });

it("o baseline real fecha a oportunidade e registra somente uma atividade sob reenvios concorrentes", async () => {
  const o = await opportunity(), event = payload(o);
  const results = await Promise.all(Array.from({ length: 8 }, () => receive(event)));
  expect(results.filter(r => r.status === "accepted")).toHaveLength(1);
  expect(results.filter(r => r.status === "duplicate")).toHaveLength(7);
  expect((await pool.query("select status,closed_at from crm_leads where id=$1", [o.lead])).rows[0])
    .toMatchObject({ status: "won", closed_at: expect.any(Date) });
  expect((await pool.query("select count(*)::int n from crm_lead_activities where lead_id=$1 and type='demand_closed'", [o.lead])).rows[0].n).toBe(1);
});

it("teste ativo e consulta antecipada nunca fecham o lead", async () => {
  const o = await opportunity(), event = payload(o);
  expect(await receive({ ...event, event_type: "trial_started", checked_at: started, occurred_at: started }))
    .toMatchObject({ decision: "trial" });
  expect(await receive({ ...event, checked_at: new Date(Date.parse(checked) - 1000).toISOString() }))
    .toMatchObject({ status: "invalid_event" });
  expect((await pool.query("select status from crm_leads where id=$1", [o.lead])).rows[0].status).toBe("open");
});

it("serviço não recebe por integração de outro tenant nem usa seu contato", async () => {
  const o = await opportunity();
  expect(await receive(payload(o),otherOrg,source)).toMatchObject({ status: "configuration_error" });
  const other = await opportunity(otherOrg,otherPipeline,otherStage);
  expect(await receive(payload(other))).toMatchObject({ decision: "manual", reason: "contact_not_unique" });
  expect((await pool.query("select status from crm_leads where id=$1", [other.lead])).rows[0].status).toBe("open");
});

for (const role of ["anon", "authenticated"] as const) {
  for (const table of ["obra_subscription_states", "obra_subscription_receipts", "obra_subscription_outreach"] as const) {
    it(`${role} com JWT não lê nem escreve ${table}, inclusive fora do workspace`, async () => {
      for (const tenant of [org,otherOrg]) {
        expect((await service.query(`select count(*)::int n from ${table} where organization_id=$1`, [tenant])).rows[0].n).toBeGreaterThan(0);
      }
      const client = await pool.connect();
      try {
        await client.query("begin"); await client.query(`set local role ${role}`);
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role })]);
        for (const tenant of [org,otherOrg]) {
          for (const sql of [`select * from ${table} where organization_id=$1`,
            `update ${table} set organization_id=organization_id where organization_id=$1`,
            `delete from ${table} where organization_id=$1`, `insert into ${table}(organization_id) values($1)`]) {
            await client.query("savepoint denied");
            await expect(client.query(sql,[tenant])).rejects.toMatchObject({ code: "42501" });
            await client.query("rollback to savepoint denied");
          }
        }
        await client.query("savepoint denied_rpc");
        await expect(client.query("select fn_receive_obra_subscription($1,$2,$3,$4,$5,$6)",
          [org,source,payload({ phone: "+12025551999", email: "test@example.invalid" }),"a".repeat(64),[],secret]))
          .rejects.toMatchObject({ code: "42501" });
      } finally { await client.query("rollback"); client.release(); }
    });
  }
}

it("nem administrador via JWT chama configuração de envios ou altera regras internas pelo banco", async () => {
  const client = await pool.connect();
  try {
    await client.query("begin"); await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub:actor,role:'authenticated' })]);
    await client.query("savepoint forbidden");
    await expect(client.query("select fn_configure_obra_outreach($1,$2,true,null,null,'a','b','c')",[org,source])).rejects.toMatchObject({ code:'42501' });
    await client.query("rollback to savepoint forbidden");
    await expect(client.query("update automation_rules set actions='[]' where organization_id=$1 and trigger_event='obra_subscription.outreach'",[org])).rejects.toMatchObject({ code:'42501' });
  } finally { await client.query("rollback");client.release(); }
});
