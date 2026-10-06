import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { validateAccessEvent } from "@/lib/obra-no-bolso/access-event";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Execute via harness PostgreSQL descartável");
const connectionString = `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT)}/postgres`;
const pool = new pg.Pool({ connectionString, max: 10 });
const service = new pg.Pool({ connectionString, max: 10, options: "-c role=service_role" });
const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID();
const secret = Buffer.from("synthetic-encrypted-secret");
let source: string, pipeline: string, openStage: string, wonStage: string;
let phoneCounter = 10;

async function seed(id: string) {
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')", [id]);
  const p = (await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Assinaturas','assinaturas',1) returning id", [id])).rows[0].id;
  const s = (await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Aberto','aberto',1) returning id", [id,p])).rows[0].id;
  const w = (await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position,is_won) values($1,$2,'Acesso ativado','acesso_ativado',2,true) returning id", [id,p])).rows[0].id;
  return { p,s,w };
}
async function opportunity(id = org) {
  const phone = `+120255501${phoneCounter++}`;
  const email = `test${phoneCounter}@example.invalid`;
  const contact = (await pool.query("insert into contacts(organization_id,name,email,phone_number) values($1,'Synthetic',$2,$3) returning id", [id,email,phone])).rows[0].id;
  const lead = (await pool.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Assinatura') returning id", [id,pipeline,openStage,contact])).rows[0].id;
  return { phone, email, contact, lead };
}
function payload(phone: string, email = "unmatched@example.invalid", eventId = randomUUID(), userId = randomUUID()) {
  return { version: 1, event_type: "first_access_granted", event_id: eventId,
    product_user_id: userId, occurred_at: "2026-10-05T17:59:00Z", user_created_at: "2026-10-05T17:30:00Z",
    name: "Synthetic", email, phone, plan: "Pro", modality: "paid",
    user_status: "active", is_new_user: true, trial_active: false, trial_ends_at: null, provider: "asaas" };
}
async function receive(input: ReturnType<typeof payload>, sourceId = source, orgId = org) {
  const parsed = validateAccessEvent(input, Date.parse("2026-10-05T18:00:00Z"));
  if (!parsed.ok) throw new Error("test_payload_invalid");
  const fingerprint = "a".repeat(64);
  return (await service.query("select fn_receive_obra_access($1,$2,$3,$4,$5,$6,$7) result",
    [orgId,sourceId,parsed.event,fingerprint,parsed.phoneVariants,null,secret])).rows[0].result;
}
beforeAll(async () => {
  const a = await seed(org); await seed(otherOrg);
  pipeline = a.p; openStage = a.s; wonStage = a.w;
  await pool.query("insert into auth.users(id,email) values($1,'obra-actor@example.invalid')", [actor]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())", [actor,org]);
  source = (await pool.query("insert into obra_access_integrations(organization_id,pipeline_id,secret_encrypted,is_active) values($1,$2,$3,true) returning id", [org,pipeline,secret])).rows[0].id;
});
afterAll(async () => { await service.end(); await pool.end(); });

it("reenvios concorrentes deixam um recibo, um vínculo e uma oportunidade", async () => {
  const o = await opportunity();
  const p = payload(o.phone,o.email);
  const results = await Promise.all(Array.from({ length: 8 }, () => receive(p)));
  expect(results.filter(r => r.status === "ready")).toHaveLength(1);
  expect(results.filter(r => r.status === "duplicate")).toHaveLength(7);
  const id = results[0].receipt_id;
  const claims = await Promise.all(Array.from({ length: 8 }, () => service.query(
    "select fn_claim_obra_access($1,$2) result", [org,id])));
  expect(claims.filter(r => r.rows[0].result.status === "claimed")).toHaveLength(1);
  expect((await pool.query("select count(*)::int n from obra_access_links where receipt_id=$1", [id])).rows[0].n).toBe(1);
  expect((await pool.query("select status from crm_leads where id=$1", [o.lead])).rows[0].status).toBe("open");
  await pool.query("update crm_leads set stage_id=$1,source_metadata=jsonb_build_object('obra_access_receipt_id',$2::text) where id=$3", [wonStage,id,o.lead]);
  const finish = (await service.query("select fn_finish_obra_access($1,$2) result", [org,id])).rows[0].result;
  expect(finish.status).toBe("processed");
  expect((await service.query("select fn_finish_obra_access($1,$2) result", [org,id])).rows[0].result.status).toBe("duplicate");
  expect((await pool.query("select count(*)::int n from event_log where event_type='obra_access.activated' and entity_id=$1", [o.lead])).rows[0].n).toBe(1);
  expect((await pool.query("select status from crm_leads where id=$1", [o.lead])).rows[0].status).toBe("won");
});

it("falha depois do registro deixa o evento retomável sem fechar lead", async () => {
  const o = await opportunity(); const p = payload(o.phone,o.email);
  const first = await receive(p);
  expect(first.status).toBe("ready");
  expect((await pool.query("select status from crm_leads where id=$1", [o.lead])).rows[0].status).toBe("open");
  expect((await receive(p)).original_status).toBe("ready");
  expect((await service.query("select fn_claim_obra_access($1,$2) result", [org,first.receipt_id])).rows[0].result.status).toBe("claimed");
  await service.query("select fn_release_obra_access($1,$2)", [org,first.receipt_id]);
  expect((await service.query("select fn_claim_obra_access($1,$2) result", [org,first.receipt_id])).rows[0].result.status).toBe("claimed");
});

it("telefone desconhecido e múltiplas oportunidades ficam pendentes sem fechamento", async () => {
  const noContact = await receive(payload("+12025550999"));
  expect(noContact).toMatchObject({ status: "pending", reason: "contact_not_found" });
  const o = await opportunity();
  await pool.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Outra assinatura')", [org,pipeline,openStage,o.contact]);
  const ambiguous = await receive(payload(o.phone,o.email));
  expect(ambiguous).toMatchObject({ status: "pending", reason: "multiple_open_leads" });
  expect((await pool.query("select count(*)::int n from crm_leads where contact_id=$1 and status='won'", [o.contact])).rows[0].n).toBe(0);
});

it("não aceita integração de outra organização e RLS não expõe segredos", async () => {
  const o = await opportunity();
  expect((await receive(payload(o.phone),source,otherOrg)).status).toBe("configuration_error");
  const authenticated = await pool.connect();
  try {
    await authenticated.query("begin");
    await authenticated.query("set local role authenticated");
    await expect(authenticated.query("select * from obra_access_integrations")).rejects.toMatchObject({ code: "42501" });
  } finally { await authenticated.query("rollback"); authenticated.release(); }
});
