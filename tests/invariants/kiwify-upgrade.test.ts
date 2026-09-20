import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { expect, it } from "vitest";
import { kiwifyFingerprint, normalizeKiwify } from "@/lib/webhooks/kiwify";

if (!process.env.TEST_DB_CONTAINER && process.env.KIWIFY_TEST_NATIVE !== "1") throw new Error("Harness PostgreSQL descartável obrigatório");
const database = process.env.KIWIFY_TEST_NATIVE === "1" ? "kiwify_test" : "postgres";

it("0221 repara o título órfão da 0220 sem perder idempotência ou emitir eventos", async () => {
  const db = new pg.Client({ host: "127.0.0.1", port: Number(process.env.TEST_DB_PORT), user: "postgres", password: "postgres", database });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("drop function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid,uuid)");
    await db.query(readFileSync("supabase/migrations/20260920120000_0220_kiwify_ingestion.sql", "utf8"));
    const org = randomUUID();
    await db.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic upgrade','Synthetic')", [org]);
    const pipeline = (await db.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Test','test',1) returning id", [org])).rows[0].id;
    const stage = (await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Test','test',1) returning id", [org,pipeline])).rows[0].id;
    const product = (await db.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,'test','Synthetic',100) returning id", [org])).rows[0].id;
    const secret = Buffer.from("synthetic-only");
    const config = { name: "Synthetic", store_id: "store-test", pipeline_id: pipeline, stage_id: stage, products: [{ external_product_id: "product-test", product_id: product }] };
    const integration = (await db.query("select fn_configure_kiwify($1,$2,$3,$4,$5) id", [org,config,randomUUID().replaceAll("-", "").repeat(2),secret,randomUUID()])).rows[0].id;
    const o = normalizeKiwify({ order_id: randomUUID(), webhook_event_type: "order_approved", order_status: "paid", Product: { product_id: "product-test" }, Customer: { full_name: "Synthetic old personal title", email: "old@example.invalid" } });
    const args = [org,integration,o,kiwifyFingerprint(o),randomUUID(),secret];
    const first = (await db.query("select fn_ingest_kiwify($1,$2,$3,$4,$5,$6) r", args)).rows[0].r;
    expect((await db.query("select title from crm_leads where id=$1", [first.lead_id])).rows[0].title).toBe("Synthetic old personal title");
    const original = (await db.query("select id,fingerprint,external_id from kiwify_receipts where id=$1", [first.receipt_id])).rows[0];
    const correction = readFileSync("supabase/migrations/20260920220000_0221_kiwify_consent_privacy_actor.sql", "utf8");
    await db.query(correction);
    await db.query(correction);
    expect((await db.query("select title,contact_id from crm_leads where id=$1", [first.lead_id])).rows[0]).toEqual({ title: "Compra Kiwify", contact_id: null });
    expect((await db.query("select fn_ingest_kiwify($1,$2,$3,$4,$5,$6) r", args)).rows[0].r).toMatchObject({ status: "duplicate", lead_id: first.lead_id });
    expect((await db.query("select id,fingerprint,external_id from kiwify_receipts where id=$1", [first.receipt_id])).rows[0]).toEqual(original);
    expect((await db.query("select count(*)::int n from event_log where organization_id=$1", [org])).rows[0].n).toBe(0);
  } finally { await db.query("rollback"); await db.end(); }
});
