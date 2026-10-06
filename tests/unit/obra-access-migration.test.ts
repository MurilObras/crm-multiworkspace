// @vitest-environment node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

const db = new PGlite();
const org = randomUUID(), integration = randomUUID(), pipeline = randomUUID(), wonStage = randomUUID();
const actor = randomUUID(), secret = new Uint8Array([1, 2, 3]);
let phoneCounter = 0;
const result = async (sql: string, args: unknown[] = []) =>
  (await db.query<{ result: Record<string, unknown> }>(sql, args)).rows[0]!.result;

function payload(phone: string, email: string, eventId = randomUUID(), userId = randomUUID()) {
  return { version: 1, event_type: "first_access_granted", event_id: eventId,
    product_user_id: userId, occurred_at: "2026-10-05T18:00:00Z",
    user_created_at: "2026-10-05T17:00:00Z", phone, name: "Synthetic", email,
    plan: "Pro", modality: "paid", provider: "asaas", user_status: "active", is_new_user: true };
}
async function opportunity() {
  const n = ++phoneCounter;
  const contact = randomUUID(), lead = randomUUID();
  const phone = `+551199999${String(n).padStart(4, "0")}`;
  const email = `synthetic${n}@example.invalid`;
  await db.query("insert into contacts values($1,$2,$3,$4,null,false)", [contact, org, phone, email]);
  await db.query("insert into crm_leads values($1,$2,$3,$4,'open','{}')", [lead, org, pipeline, contact]);
  return { contact, lead, phone, email };
}
async function receive(event: ReturnType<typeof payload>, variants = [event.phone], fingerprint = "a".repeat(64)) {
  return result("select fn_receive_obra_access($1,$2,$3::jsonb,$4,$5::text[],$6,$7) result",
    [org, integration, JSON.stringify(event), fingerprint, variants, null, secret]);
}

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table organizations(id uuid primary key);
    create table crm_pipelines(id uuid primary key, organization_id uuid);
    create table contacts(id uuid primary key, organization_id uuid, phone_number text,
      email_normalized text, is_merged_into uuid, is_anonymized boolean default false);
    create table crm_leads(id uuid primary key, organization_id uuid, pipeline_id uuid,
      contact_id uuid, status text default 'open', source_metadata jsonb default '{}');
    create table crm_stages(id uuid primary key, organization_id uuid, pipeline_id uuid,
      name text, is_won boolean, is_archived boolean default false);
    create table event_log(id uuid primary key default gen_random_uuid(), organization_id uuid,
      event_type text, entity_kind text, entity_id uuid, payload jsonb);
    create table api_audit_log(id uuid primary key default gen_random_uuid(), organization_id uuid,
      actor_user_id uuid, action text, resource_type text, resource_id uuid, request_id text, metadata jsonb);
    create table user_organizations(user_id uuid, organization_id uuid, role text,
      revoked_at timestamptz, accepted_at timestamptz);
    create table automation_rules(organization_id uuid, trigger_event text);
    create function fn_role_at_least(uuid,text) returns boolean language sql as $$ select false $$;
    create function fn_is_platform_admin() returns boolean language sql as $$ select false $$;
    alter table automation_rules enable row level security;
    create policy automation_rules_test on automation_rules for all to authenticated
      using(true) with check(true);
    grant select on automation_rules to authenticated;
    create function emit_event(text,text,uuid,jsonb,jsonb,uuid) returns uuid language plpgsql as $$
    declare v uuid;
    begin insert into event_log(organization_id,event_type,entity_kind,entity_id,payload)
      values($6,$1,$2,$3,$4) returning id into v; return v; end $$;
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261005190000_0229_obra_no_bolso_access.sql", import.meta.url), "utf8"));
  await db.query("insert into organizations values($1)", [org]);
  await db.query("insert into crm_pipelines values($1,$2)", [pipeline, org]);
  await db.query("insert into crm_stages values($1,$2,$3,'Acesso ativado',true,false)", [wonStage, org, pipeline]);
  await db.query("insert into user_organizations values($1,$2,'admin',null,now())", [actor, org]);
  await db.query("insert into obra_access_integrations(id,organization_id,pipeline_id,secret_encrypted) values($1,$2,$3,$4)",
    [integration, org, pipeline, secret]);
});
afterAll(async () => { await db.close(); });

it("nasce desligada e não aceita evento sem ativação", async () => {
  expect((await receive(payload("+5511999990000", "x@example.invalid"))).status).toBe("configuration_error");
  expect((await db.query<{ is_active: boolean }>("select is_active from obra_access_integrations where id=$1", [integration])).rows[0]!.is_active).toBe(false);
  await db.query("update obra_access_integrations set is_active=true where id=$1", [integration]);
});

it("telefone desconhecido ou múltiplas oportunidades permanecem pendentes", async () => {
  expect(await receive(payload("+5511999999999", "x@example.invalid"))).toMatchObject({ status: "pending", reason: "contact_not_found" });
  const o = await opportunity();
  await db.query("insert into crm_leads values($1,$2,$3,$4,'open','{}')", [randomUUID(), org, pipeline, o.contact]);
  expect(await receive(payload(o.phone, o.email))).toMatchObject({ status: "pending", reason: "multiple_open_leads" });
  expect((await db.query<{ n: number }>("select count(*)::int n from obra_access_links where contact_id=$1", [o.contact])).rows[0]!.n).toBe(0);
});

it("reenvios, claim, fechamento e falha posterior preservam exatamente uma conversão", async () => {
  const o = await opportunity(), event = payload(o.phone, o.email);
  const receipts = await Promise.all(Array.from({ length: 4 }, () => receive(event)));
  expect(receipts.filter(r => r.status === "ready")).toHaveLength(1);
  expect(receipts.filter(r => r.status === "duplicate")).toHaveLength(3);
  expect((await receive(event, [event.phone], "b".repeat(64))).status).toBe("conflict");
  const receiptId = receipts[0]!.receipt_id;
  expect((await result("select fn_claim_obra_access($1,$2) result", [org, receiptId])).status).toBe("claimed");
  expect((await result("select fn_finish_obra_access($1,$2) result", [org, receiptId])).status).toBe("closure_unconfirmed");
  await db.query("update crm_leads set status='won',source_metadata=jsonb_build_object('obra_access_receipt_id',$1::text) where id=$2", [receiptId, o.lead]);
  expect((await result("select fn_finish_obra_access($1,$2) result", [org, receiptId])).status).toBe("processed");
  expect((await result("select fn_finish_obra_access($1,$2) result", [org, receiptId])).status).toBe("duplicate");
  expect((await db.query<{ n: number }>("select count(*)::int n from event_log where event_type='obra_access.activated' and entity_id=$1", [o.lead])).rows[0]!.n).toBe(1);
  expect((await db.query<{ n: number }>("select count(*)::int n from obra_access_links where lead_id=$1", [o.lead])).rows[0]!.n).toBe(1);
});

it("associação manual exige admin, preserva o vínculo único e grava auditoria", async () => {
  const o = await opportunity();
  const pending = await receive(payload("+5511999998888", o.email));
  const request = randomUUID();
  await expect(result("select fn_manual_link_obra_access($1,$2,$3,$4,$5,$6) result",
    [org, pending.receipt_id, o.contact, o.lead, randomUUID(), request])).rejects.toThrow();
  const linked = await result("select fn_manual_link_obra_access($1,$2,$3,$4,$5,$6) result",
    [org, pending.receipt_id, o.contact, o.lead, actor, request]);
  expect(linked.status).toBe("ready");
  expect((await db.query<{ n: number }>("select count(*)::int n from api_audit_log where action='obra_access.manual_link' and resource_id=$1", [pending.receipt_id])).rows[0]!.n).toBe(1);
  await expect(result("select fn_manual_link_obra_access($1,$2,$3,$4,$5,$6) result",
    [org, pending.receipt_id, o.contact, o.lead, actor, randomUUID()])).rejects.toThrow();
});

it("se a oportunidade mudou antes do fechamento, pendência pode ser reassociada", async () => {
  const o = await opportunity();
  const first = await receive(payload(o.phone, o.email));
  expect(first.status).toBe("ready");
  await db.query("update crm_leads set status='won' where id=$1", [o.lead]);
  expect((await result("select fn_claim_obra_access($1,$2) result", [org, first.receipt_id])).status).toBe("pending");
  const replacement = randomUUID();
  await db.query("insert into crm_leads values($1,$2,$3,$4,'open','{}')", [replacement, org, pipeline, o.contact]);
  expect((await result("select fn_manual_link_obra_access($1,$2,$3,$4,$5,$6) result",
    [org, first.receipt_id, o.contact, replacement, actor, randomUUID()])).status).toBe("ready");
  expect((await db.query<{ lead_id: string }>("select lead_id from obra_access_links where receipt_id=$1", [first.receipt_id])).rows[0]!.lead_id).toBe(replacement);
});

it("bloqueia troca do funil após recebimentos mesmo com conexão desligada", async () => {
  const otherPipeline = randomUUID();
  await db.query("insert into crm_pipelines values($1,$2)", [otherPipeline, org]);
  await expect(db.query("update obra_access_integrations set pipeline_id=$1 where id=$2", [otherPipeline, integration])).rejects.toThrow();
  await db.query("update obra_access_integrations set is_active=false where id=$1", [integration]);
  await expect(db.query("update obra_access_integrations set pipeline_id=$1 where id=$2", [otherPipeline, integration])).rejects.toThrow();
});

it("RLS reserva as regras do acesso Obra no Bolso ao administrador", async () => {
  await db.query("insert into automation_rules values($1,'obra_access.activated'),($1,'lead.created')", [org]);
  await db.exec("begin; set local role authenticated;");
  try {
    const visible = await db.query<{ trigger_event: string }>("select trigger_event from automation_rules");
    expect(visible.rows.map(row => row.trigger_event)).toEqual(["lead.created"]);
  } finally {
    await db.exec("rollback");
  }
});

it("a migração pode ser aplicada novamente sem alterar os vínculos", async () => {
  const before = (await db.query<{ n: number }>("select count(*)::int n from obra_access_links")).rows[0]!.n;
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261005190000_0229_obra_no_bolso_access.sql", import.meta.url), "utf8"));
  const after = (await db.query<{ n: number }>("select count(*)::int n from obra_access_links")).rows[0]!.n;
  expect(after).toBe(before);
});
