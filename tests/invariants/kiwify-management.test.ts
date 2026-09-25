import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { beforeAll, afterAll, it, expect } from "vitest";
import { normalizeKiwify, kiwifyFingerprint } from "@/lib/webhooks/kiwify";

if (!process.env.TEST_DB_CONTAINER && process.env.KIWIFY_TEST_NATIVE !== "1") throw new Error("Use o harness descartável");
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT)}/${process.env.KIWIFY_TEST_NATIVE === "1" ? "kiwify_test" : "postgres"}`, max: 8 });
const org = randomUUID(), actor = randomUUID(), alien = randomUUID();
let pipeline: string, stage: string, product: string;
const secret = Buffer.from("synthetic-ciphertext");
const migration = readFileSync("supabase/migrations/20260924120000_0227_kiwify_management.sql", "utf8");
const config = (store = randomUUID()) => ({ name: "Synthetic", store_id: store, pipeline_id: pipeline, stage_id: stage, products: [{ external_product_id: "sku", product_id: product }] });
async function create(c = config()) {
  return (await pool.query("select fn_configure_kiwify($1,$2,$3,$4,$5,$6) id", [org,c,randomUUID().replaceAll("-", "").repeat(2),secret,randomUUID(),actor])).rows[0].id as string;
}
async function manage(id: string, operation: string, c: unknown = {}, tenant = org, rotated: Buffer | null = null) {
  return pool.query("select fn_manage_kiwify($1,$2,$3,$4,$5,$6,$7)", [tenant,id,operation,c,rotated,actor,randomUUID()]);
}
async function rule(legacy = false) {
  return (await pool.query(`insert into automation_rules(organization_id,name,trigger_event,conditions,actions,is_active,kiwify_links_initialized)
    values($1,'Synthetic','lead.created',$2,'[]',true,$3) returning id`, [org, JSON.stringify([{ field: "event.kiwify_event_type", op: "eq", value: "order_approved" }]), !legacy])).rows[0].id;
}
beforeAll(async () => {
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic'),($2::uuid,$2::text,'Alien','Alien')", [org,alien]);
  await pool.query("insert into auth.users(id,email) values($1,'management@example.invalid')", [actor]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [actor,org]);
  pipeline=(await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Test','test',1) returning id", [org])).rows[0].id;
  stage=(await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Test','test',1) returning id", [org,pipeline])).rows[0].id;
  product=(await pool.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,'sku','Synthetic',100) returning id", [org])).rows[0].id;
});
afterAll(() => pool.end());
it("edita atomicamente, preserva segredo vazio e URL; segredo novo só muda a cifra", async () => {
  const c = config(), id = await create(c);
  const before = (await pool.query("select path_token,secret_encrypted from kiwify_integrations where id=$1", [id])).rows[0];
  await manage(id,"edit",{ ...c, name: "Changed", products: [{ external_product_id: "new-sku", product_id: product }] });
  expect((await pool.query("select path_token,secret_encrypted from kiwify_integrations where id=$1", [id])).rows[0]).toEqual(before);
  const mappings = (await pool.query("select * from kiwify_product_mappings where integration_id=$1", [id])).rows;
  await expect(manage(id,"edit",{ ...c, products: [...c.products, { external_product_id: "invalid", product_id: randomUUID() }] })).rejects.toThrow("invalid_product");
  expect((await pool.query("select * from kiwify_product_mappings where integration_id=$1", [id])).rows).toEqual(mappings);
  await manage(id,"edit",c,org,Buffer.from("rotated-synthetic"));
  expect((await pool.query("select path_token from kiwify_integrations where id=$1", [id])).rows[0].path_token).toBe(before.path_token);
  expect((await pool.query("select secret_encrypted from kiwify_integrations where id=$1", [id])).rows[0].secret_encrypted).toEqual(Buffer.from("rotated-synthetic"));
});
it("arquiva, preserva receipt/lead/contato/auditoria/regras e libera Store ID", async () => {
  const c = config(), id = await create(c), r = await rule();
  await manage(id,"link",{ rule_id: r });
  const order=normalizeKiwify({ order_id: randomUUID(), store_id: c.store_id, webhook_event_type: "order_approved", order_status: "paid", Product: { product_id: "sku" }, Customer: { mobile: "+12025550117" } });
  const args = [org,id,order,kiwifyFingerprint(order),randomUUID(),secret];
  const receipt=(await pool.query("select fn_ingest_kiwify($1,$2,$3,$4,$5,$6) result",args)).rows[0].result;
  const counts = async () => (await pool.query("select (select count(*) from kiwify_receipts where integration_id=$1)::int receipts,(select count(*) from crm_leads where id=$2)::int leads,(select count(*) from contacts where organization_id=$3)::int contacts,(select count(*) from automation_rules where id=$4)::int rules",[id,receipt.lead_id,org,r])).rows[0];
  const before = await counts();
  await manage(id,"archive"); await manage(id,"archive");
  expect(await counts()).toEqual(before);
  expect((await pool.query("select fn_ingest_kiwify($1,$2,$3,$4,$5,$6) result",args)).rows[0].result.status).toBe("configuration_error");
  expect(await create(c)).not.toBe(id);
  expect((await pool.query("select count(*)::int n from api_audit_log where resource_id=$1 and action='kiwify.archive'",[id])).rows[0].n).toBe(1);
  expect((await pool.query("select count(*)::int n from kiwify_automation_links where integration_id=$1",[id])).rows[0].n).toBe(1);
});
it("link concorrente não duplica; unlink, edição e arquivo não apagam regra", async () => {
  const c=config(), id=await create(c), r=await rule();
  await Promise.all(Array.from({ length: 8 }, () => manage(id,"link",{ rule_id:r })));
  expect((await pool.query("select count(*)::int n from kiwify_automation_links where integration_id=$1",[id])).rows[0].n).toBe(1);
  await manage(id,"unlink",{ rule_id:r }); await manage(id,"edit",c); await manage(id,"archive");
  expect((await pool.query("select id from automation_rules where id=$1",[r])).rows).toHaveLength(1);
  expect((await pool.query("select * from kiwify_automation_links where integration_id=$1",[id])).rows).toHaveLength(0);
});
it("tenant e referências inválidas são recusados", async () => {
  const c=config(), id=await create(c);
  await expect(manage(id,"edit",c,alien)).rejects.toThrow("invalid_configuration_actor");
  await expect(manage(id,"edit",{...c,stage_id:randomUUID()})).rejects.toThrow("invalid_stage");
  await expect(manage(id,"link",{rule_id:randomUUID()})).rejects.toThrow("automation_not_found");
  await expect(create(c)).rejects.toMatchObject({ code: "23505" });
});
it("falha durante INSERT dos mappings desfaz também DELETE e edição da integração", async () => {
  const c=config(), id=await create(c);
  await pool.query(`create function public.test_kiwify_mapping_failure() returns trigger language plpgsql as $$
    begin if new.external_product_id='explode' then raise exception 'synthetic_mapping_failure'; end if; return new; end $$;
    create trigger test_mapping_failure before insert on kiwify_product_mappings for each row execute function public.test_kiwify_mapping_failure();`);
  try {
    await expect(manage(id,"edit",{...c,name:"Must rollback",products:[{external_product_id:"valid-first",product_id:product},{external_product_id:"explode",product_id:product}]})).rejects.toThrow("synthetic_mapping_failure");
    expect((await pool.query("select name from kiwify_integrations where id=$1",[id])).rows[0].name).toBe(c.name);
    expect((await pool.query("select external_product_id,product_id from kiwify_product_mappings where integration_id=$1",[id])).rows).toEqual(c.products);
  } finally { await pool.query("drop trigger test_mapping_failure on kiwify_product_mappings; drop function public.test_kiwify_mapping_failure()"); }
});
it("backfill mantém regras antigas ativas; reaplicar não recria unlink", async () => {
  const id=await create(), legacy=await rule(true);
  await pool.query(migration);
  expect((await pool.query("select * from kiwify_automation_links where integration_id=$1 and rule_id=$2",[id,legacy])).rows).toHaveLength(1);
  expect((await pool.query("select is_active from automation_rules where id=$1",[legacy])).rows[0].is_active).toBe(true);
  await manage(id,"unlink",{rule_id:legacy}); await pool.query(migration);
  expect((await pool.query("select * from kiwify_automation_links where integration_id=$1 and rule_id=$2",[id,legacy])).rows).toHaveLength(0);
});
it("backfill vincula regra legada pausada sem reativá-la, inclusive na reaplicação", async () => {
  const id=await create(), paused=await rule(true);
  await pool.query("update automation_rules set is_active=false where id=$1",[paused]);
  await pool.query(migration);
  expect((await pool.query("select rule_id from kiwify_automation_links where organization_id=$1 and integration_id=$2 and rule_id=$3",[org,id,paused])).rows).toEqual([{rule_id:paused}]);
  expect((await pool.query("select is_active from automation_rules where id=$1",[paused])).rows[0].is_active).toBe(false);
  await pool.query(migration);
  expect((await pool.query("select is_active from automation_rules where id=$1",[paused])).rows[0].is_active).toBe(false);
});
it("vínculos são privados sob JWT/RLS; serviço não consegue gravar FK cross-tenant", async () => {
  const id=await create(), own=await rule();await manage(id,"link",{rule_id:own});
  const foreign=(await pool.query("insert into automation_rules(organization_id,name,trigger_event,conditions,actions) values($1,'Foreign','lead.created','[]','[]') returning id",[alien])).rows[0].id;
  await expect(manage(id,"link",{rule_id:foreign})).rejects.toThrow("automation_not_found");
  const db=await pool.connect();
  try {
    for(const role of ["anon","authenticated"]){
      for(const statement of ["select * from kiwify_automation_links", "delete from kiwify_automation_links"]){
        await db.query("begin");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
        await db.query(`set local role ${role}`);
        await expect(db.query(statement)).rejects.toMatchObject({code:"42501"});
        await db.query("rollback");
      }
    }
    await db.query("begin");await db.query("set local role service_role");
    expect((await db.query("select rule_id from kiwify_automation_links where organization_id=$1 and integration_id=$2",[org,id])).rows).toEqual([{rule_id:own}]);
    await expect(db.query("insert into kiwify_automation_links values($1,$2,$3)",[org,id,foreign])).rejects.toMatchObject({code:"23503"});
  } finally {await db.query("rollback");db.release();}
});
