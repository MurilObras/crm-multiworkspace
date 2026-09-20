import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { kiwifyFingerprint, normalizeKiwify } from "@/lib/webhooks/kiwify";

// Só o harness efêmero do repositório. Nunca usa DATABASE_URL/.env.
if (!process.env.TEST_DB_CONTAINER && process.env.KIWIFY_TEST_NATIVE !== "1") throw new Error("Execute via harness PostgreSQL descartável");
const database = process.env.KIWIFY_TEST_NATIVE === "1" ? "kiwify_test" : "postgres";
const connectionString = `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT)}/${database}`;
const pool = new pg.Pool({ connectionString, max: 8 });
const service = new pg.Pool({ connectionString, max: 8, options: "-c role=service_role" });
const org = randomUUID(), otherOrg = randomUUID(), user = randomUUID();
let integration: string, secondStore: string, otherIntegration: string, product: string, otherProduct: string;
const secret = Buffer.from("synthetic-encrypted-test");
async function setup(id: string) {
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')", [id]);
  const p = (await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Test','test',1) returning id", [id])).rows[0].id;
  const s = (await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Test','test',1) returning id", [id,p])).rows[0].id;
  const prod = (await pool.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,'test','Synthetic',100) returning id", [id])).rows[0].id;
  async function config(store: string) {
    const c = { name: "Synthetic", store_id: store, pipeline_id: p, stage_id: s, products: [{ external_product_id: "product-test", product_id: prod }] };
    return (await service.query("select fn_configure_kiwify($1,$2,$3,$4,$5) id", [id,c,randomUUID().replaceAll("-","").repeat(2),secret,randomUUID()])).rows[0].id;
  }
  return { prod, config };
}
beforeAll(async () => {
  const a = await setup(org), b = await setup(otherOrg);
  product = a.prod; otherProduct = b.prod;
  integration = await a.config("store-test"); secondStore = await a.config("store-second"); otherIntegration = await b.config("store-test");
  await pool.query("insert into auth.users(id,email) values($1,'synthetic@example.invalid')", [user]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [user,org]);
});
afterAll(async () => { await service.end(); await pool.end(); });
function order(id = randomUUID(), overrides = {}) {
  return normalizeKiwify({ order_id: id, webhook_event_type: "order_approved", order_status: "paid", Product: { product_id: "product-test" }, Customer: { full_name: "Synthetic", mobile: "+12025550123" }, ...overrides });
}
async function ingest(o = order(), source = integration, organization = org) {
  return (await service.query("select fn_ingest_kiwify($1,$2,$3,$4,$5,$6) result", [organization,source,o,kiwifyFingerprint(o),randomUUID(),secret])).rows[0].result;
}
it("retries sequenciais e oito concorrentes produzem um lead e um evento", async () => {
  const o = order();
  const gate = await pool.connect();
  await gate.query("begin");
  await gate.query("select id from kiwify_integrations where id=$1 for update", [integration]);
  const concurrent = Promise.all(Array.from({ length: 8 }, () => ingest(o)));
  try {
    // Barreira no banco: prova OITO sessões simultaneamente esperando o lock,
    // não apenas oito Promises que poderiam completar uma após a outra.
    await vi.waitFor(async () => {
      const { rows } = await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select fn_ingest_kiwify%'");
      expect(rows[0].n).toBe(8);
    }, { timeout: 5000 });
  } finally { await gate.query("commit"); gate.release(); }
  const results = await concurrent;
  expect(results.filter(r => r.status === "accepted")).toHaveLength(1);
  expect(results.filter(r => r.status === "duplicate")).toHaveLength(7);
  expect((await ingest(o)).status).toBe("duplicate");
  const receipt = (await pool.query("select * from kiwify_receipts where order_id=$1", [o.order_id])).rows;
  expect(receipt).toHaveLength(1);
  expect((await pool.query("select count(*)::int n from event_log where entity_id=$1 and event_type='lead.created'", [receipt[0].lead_id])).rows[0].n).toBe(1);
  expect((await pool.query("select count(*)::int n from crm_leads where external_id=$1", [receipt[0].external_id])).rows[0].n).toBe(1);
  expect((await pool.query("select count(*)::int n from contacts where organization_id=$1", [org])).rows[0].n).toBe(1);
  expect((await pool.query("select count(*)::int n from webhook_lead_captures where lead_id=$1", [receipt[0].lead_id])).rows[0].n).toBe(1);
  expect((await pool.query("select count(*)::int n from api_audit_log where resource_id=$1 and action='kiwify.received'", [receipt[0].id])).rows[0].n).toBe(1);
  expect((await service.query("select current_user role")).rows[0].role).toBe("service_role");
  await expect(pool.query("insert into kiwify_receipts(organization_id,integration_id,order_id,event_type,fingerprint,status,external_id) select organization_id,integration_id,order_id,event_type,fingerprint,status,external_id from kiwify_receipts where id=$1", [receipt[0].id])).rejects.toMatchObject({ code: "23505" });
});
it.each([['order_refunded','refunded'],['chargeback','chargedback'],['pix_created','waiting_payment'],['order_approved','waiting_payment']])("ignora %s/%s sem lead/evento", async (event, status) => {
  const result = await ingest(order(randomUUID(), { webhook_event_type: event, order_status: status }));
  expect(result.status).toBe("ignored"); expect(result.lead_id).toBeNull();
});
it("produto desconhecido é ignorado; FK impede produto alheio", async () => {
  expect((await ingest(order(randomUUID(), { Product: { product_id: "unknown" } }))).status).toBe("ignored");
  await expect(service.query("insert into kiwify_product_mappings values($1,$2,'foreign',$3)", [org,integration,otherProduct])).rejects.toMatchObject({ code: "23503" });
  expect(product).not.toBe(otherProduct);
});
it("mesmo pedido é independente entre lojas e organizações; body não escolhe loja", async () => {
  const o = order(); const a = await ingest(o), b = await ingest(o,secondStore), c = await ingest(o,otherIntegration,otherOrg);
  expect(new Set([a.lead_id,b.lead_id,c.lead_id]).size).toBe(3);
  expect((await ingest(o,otherIntegration,org)).status).toBe("configuration_error");
  expect((await ingest(order(randomUUID(), { store_id: "forged" }))).status).toBe("invalid");
});
it("sem telefone não vincula contato por e-mail e não emite automação", async () => {
  const r = await ingest(order(randomUUID(), { Customer: { email: "only@example.invalid" } }));
  expect(r.status).toBe("accepted_no_phone");
  const row = (await pool.query("select l.contact_id,r.event_id from kiwify_receipts r join crm_leads l on l.id=r.lead_id where r.id=$1", [r.receipt_id])).rows[0];
  expect(row).toEqual({ contact_id: null, event_id: null });
});
it("preserva nome/email/opt-out existente, sem evento para bloqueado", async () => {
  const phone = "+12025550124";
  const contact = (await pool.query("insert into contacts(organization_id,name,email,phone_number,is_blocked) values($1,'Preservar','keep@example.invalid',$2,true) returning id,consent", [org,phone])).rows[0];
  const r = await ingest(order(randomUUID(), { Customer: { mobile: phone, full_name: "", email: "" } }));
  const actual = (await pool.query("select name,email,is_blocked,consent from contacts where id=$1", [contact.id])).rows[0];
  expect(actual).toEqual({ name: "Preservar", email: "keep@example.invalid", is_blocked: true, consent: contact.consent });
  expect((await pool.query("select event_id from kiwify_receipts where id=$1", [r.receipt_id])).rows[0].event_id).toBeNull();
});
it("conflito não substitui original nem recria efeitos", async () => {
  const o = order(); const r = await ingest(o);
  expect((await ingest({ ...o, email: "changed@example.invalid" })).status).toBe("conflict");
  const stored = (await pool.query("select fingerprint,conflict_count,lead_id from kiwify_receipts where id=$1", [r.receipt_id])).rows[0];
  expect(stored).toEqual({ fingerprint: kiwifyFingerprint(o), conflict_count: 1, lead_id: r.lead_id });
});
it("variante brasileira legada bloqueada não é contornada por cadastro novo", async () => {
  await pool.query("insert into contacts(organization_id,name,phone_number,is_blocked) values($1,'Synthetic legacy','+551198765432',true)", [org]);
  const r = await ingest(order(randomUUID(), { Customer: { mobile: "+5511998765432" } }));
  expect(r.reason).toBe("contact_blocked");
  expect((await pool.query("select count(*)::int n from contacts where organization_id=$1 and phone_number='+5511998765432'", [org])).rows[0].n).toBe(0);
});
it("configuração sem mapeamento não confirma recebimento", async () => {
  await pool.query("delete from kiwify_product_mappings where organization_id=$1 and integration_id=$2", [org,secondStore]);
  try { expect((await ingest(order(),secondStore)).status).toBe("configuration_error"); }
  finally { await pool.query("insert into kiwify_product_mappings values($1,$2,'product-test',$3)", [org,secondStore,product]); }
});
it("falha depois de lead/evento desfaz tudo; retry recupera", async () => {
  const o = order();
  await pool.query("create function public.kiwify_test_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$; create trigger kiwify_test_fail before insert on public.webhook_lead_captures for each row execute function public.kiwify_test_fail()");
  try { await expect(ingest(o)).rejects.toThrow("synthetic failure"); }
  finally { await pool.query("drop trigger kiwify_test_fail on public.webhook_lead_captures; drop function public.kiwify_test_fail()"); }
  expect((await pool.query("select count(*)::int n from kiwify_receipts where order_id=$1", [o.order_id])).rows[0].n).toBe(0);
  expect((await pool.query("select count(*)::int n from crm_leads where external_id=$1", [`kiwify:${integration}:${o.order_id}`])).rows[0].n).toBe(0);
  expect((await pool.query("select count(*)::int n from event_log where metadata->>'external_id'=$1", [`kiwify:${integration}:${o.order_id}`])).rows[0].n).toBe(0);
  expect((await ingest(o)).status).toBe("accepted");
});
it("RLS não lê outra organização e funções não são RPCs públicas", async () => {
  await ingest(order()); await ingest(order(),otherIntegration,otherOrg);
  const client = await pool.connect();
  try {
    await client.query("begin; set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })]);
    expect((await client.query("select count(*)::int n from kiwify_receipts where organization_id=$1", [otherOrg])).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int n from kiwify_receipts where organization_id=$1", [org])).rows[0].n).toBeGreaterThan(0);
  } finally { await client.query("rollback"); client.release(); }
  expect((await pool.query("select has_function_privilege('anon','fn_ingest_kiwify(uuid,uuid,jsonb,text,uuid,bytea)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
  expect((await pool.query("select has_function_privilege('authenticated','fn_ingest_kiwify(uuid,uuid,jsonb,text,uuid,bytea)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});

it.each(["anon", "authenticated"])("%s não lê segredos, não escreve tabelas e não executa RPCs", async role => {
  const client = await pool.connect();
  try {
    for (const statement of [
      "select * from kiwify_integrations",
      "select * from kiwify_product_mappings",
      "insert into kiwify_integrations default values",
      "delete from kiwify_integrations",
      "insert into kiwify_product_mappings default values",
      "delete from kiwify_product_mappings",
      "delete from kiwify_receipts",
      "update kiwify_receipts set status='accepted'",
      "insert into kiwify_receipts default values",
      "truncate kiwify_receipts",
      "select fn_configure_kiwify(null,null,null,null,null)",
      "select fn_ingest_kiwify(null,null,null,null,null,null)",
    ]) {
      await client.query(`begin; set local role ${role}`);
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })]);
      await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    }
  } finally { await client.query("rollback"); client.release(); }
});

it("RPCs são invoker com search_path fixo; definer de cifra permanece restrita", async () => {
  const { rows } = await pool.query("select proname,prosecdef,proconfig from pg_proc where proname in ('fn_ingest_kiwify','fn_configure_kiwify')");
  expect(rows).toHaveLength(2);
  for (const r of rows) { expect(r.prosecdef).toBe(false); expect(r.proconfig).toContain("search_path=public, pg_temp"); }
  const grants = (await pool.query("select has_function_privilege('anon','fn_decrypt_oauth(bytea)','execute') a, has_function_privilege('authenticated','fn_decrypt_oauth(bytea)','execute') b, has_function_privilege('service_role','fn_decrypt_oauth(bytea)','execute') c")).rows[0];
  expect(grants).toEqual({ a: false, b: false, c: true });
  const helpers = (await pool.query("select proname,prosecdef,proconfig,has_function_privilege('anon',oid,'execute') anon from pg_proc where pronamespace='public'::regnamespace and proname in ('emit_event','fn_encrypt_oauth','fn_decrypt_oauth')")).rows;
  expect(helpers).toHaveLength(3);
  for (const helper of helpers) {
    expect(helper.prosecdef).toBe(true); expect(helper.anon).toBe(false);
    expect(helper.proconfig.some((value: string) => value.startsWith("search_path=public"))).toBe(true);
  }
});

it("contato anonimizado e telefone ambíguo não criam lead ou evento", async () => {
  await pool.query("insert into contacts(organization_id,name,phone_number,is_anonymized,anonymized_at) values($1,'Synthetic anonymous','+12025550129',true,now())", [org]);
  const anonymous = await ingest(order(randomUUID(), { Customer: { mobile: "+12025550129" } }));
  expect(anonymous).toMatchObject({ status: "invalid", lead_id: null });
  await pool.query("insert into contacts(organization_id,name,phone_number) values($1,'Synthetic A','+551198765433'),($1,'Synthetic B','+5511998765433')", [org]);
  const ambiguous = await ingest(order(randomUUID(), { Customer: { mobile: "+5511998765433" } }));
  expect(ambiguous).toMatchObject({ status: "invalid", lead_id: null });
  expect((await pool.query("select count(*)::int n from kiwify_receipts where id=any($1::uuid[]) and event_id is not null", [[anonymous.receipt_id,ambiguous.receipt_id]])).rows[0].n).toBe(0);
});

it.each(["contacts", "crm_leads", "event_log", "kiwify_receipts", "webhook_lead_captures", "api_audit_log"])("falha em %s faz rollback das seis tabelas e retry recupera", async table => {
  const suffix = 30 + ["contacts", "crm_leads", "event_log", "kiwify_receipts", "webhook_lead_captures", "api_audit_log"].indexOf(table);
  const o = order(randomUUID(), { Customer: { mobile: `+120255501${suffix}` } });
  const counts = async () => (await pool.query("select (select count(*) from contacts) contacts,(select count(*) from crm_leads) leads,(select count(*) from event_log) events,(select count(*) from kiwify_receipts) receipts,(select count(*) from webhook_lead_captures) captures,(select count(*) from api_audit_log) audit")).rows[0];
  const before = await counts();
  await pool.query(`create function public.kiwify_inject_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic rollback'; end $$; create trigger kiwify_inject_failure before insert on public.${table} for each row execute function public.kiwify_inject_failure()`);
  try { await expect(ingest(o)).rejects.toThrow("synthetic rollback"); }
  finally { await pool.query(`drop trigger kiwify_inject_failure on public.${table}; drop function public.kiwify_inject_failure()`); }
  expect(await counts()).toEqual(before);
  expect((await ingest(o)).status).toBe("accepted");
  expect((await ingest(o)).status).toBe("duplicate");
});
