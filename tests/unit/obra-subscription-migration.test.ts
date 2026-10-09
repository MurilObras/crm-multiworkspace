// @vitest-environment node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

const db = new PGlite();
const org = randomUUID(), otherOrg = randomUUID(), integration = randomUUID(), pipeline = randomUUID();
const openStage = randomUUID(), wonStage = randomUUID();
const secret = new Uint8Array([1, 2, 3]);
const checked = new Date(Date.now() - 60_000).toISOString();
const started = new Date(Date.parse(checked) - 96 * 3600_000).toISOString();
const migration = readFileSync(new URL("../../supabase/migrations/20261008210000_0230_obra_subscription_lifecycle.sql", import.meta.url), "utf8");
let counter = 0;

async function opportunity() {
  const n = ++counter, contact = randomUUID(), lead = randomUUID();
  const phone = `+551199999${String(n).padStart(4, "0")}`, email = `test${n}@example.invalid`;
  await db.query("insert into contacts(id,organization_id,phone_number,email_normalized) values($1,$2,$3,$4)", [contact, org, phone, email]);
  await db.query("insert into crm_leads(id,organization_id,pipeline_id,contact_id,stage_id) values($1,$2,$3,$4,$5)", [lead, org, pipeline, contact, openStage]);
  return { contact, lead, phone, email };
}
function payload(o: { phone: string; email: string }, product_user_id = randomUUID()) {
  return { version: 2, event_type: "subscription_status_checked", event_id: randomUUID(), product_user_id,
    occurred_at: checked, checked_at: checked, trial_started_at: started, name: "Synthetic", email: o.email, phone: o.phone,
    status_pagamento: "ativo", em_trial: false, access_enabled: true,
    trial_ends_at: null as string | null, access_expires_at: new Date(Date.parse(checked) + 30 * 86400_000).toISOString() };
}
async function receive(event: ReturnType<typeof payload>, options: { fingerprint?: string; org?: string; secret?: Uint8Array } = {}) {
  return (await db.query<{ result: Record<string, unknown> }>("select fn_receive_obra_subscription($1,$2,$3::jsonb,$4,$5::text[],$6) result",
    [options.org ?? org, integration, JSON.stringify(event), options.fingerprint ?? "a".repeat(64), [event.phone], options.secret ?? secret])).rows[0]!.result;
}
const state = async (user: string) => (await db.query<{ converted_at: string | null; decision: string }>("select * from obra_subscription_states where product_user_id=$1", [user])).rows[0]!;
const leadStatus = async (id: string) => (await db.query<{ status: string }>("select status from crm_leads where id=$1", [id])).rows[0]!.status;

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table organizations(id uuid primary key);
    create table crm_pipelines(id uuid primary key, organization_id uuid);
    create table contacts(id uuid primary key, organization_id uuid, phone_number text,
      email_normalized text, is_merged_into uuid, is_anonymized boolean default false,
      tags text[] default '{}', updated_at timestamptz default now());
    create table crm_leads(id uuid primary key, organization_id uuid, pipeline_id uuid,
      contact_id uuid, status text default 'open', source_metadata jsonb default '{}', stage_id uuid,
      position_in_stage numeric default 0,updated_at timestamptz default now());
    create table crm_stages(id uuid primary key, organization_id uuid, pipeline_id uuid,
      name text, is_won boolean, is_archived boolean default false);
    create table crm_lead_activities(id uuid primary key default gen_random_uuid(),organization_id uuid,
      lead_id uuid,contact_id uuid,source_module text,source_id uuid,type text,payload jsonb,metadata jsonb);
    create table event_log(id uuid primary key default gen_random_uuid(), organization_id uuid,
      event_type text, entity_kind text, entity_id uuid, payload jsonb);
    create table api_audit_log(id uuid primary key default gen_random_uuid(), organization_id uuid,
      actor_user_id uuid, action text, resource_type text, resource_id uuid, request_id text, metadata jsonb);
    create table user_organizations(user_id uuid, organization_id uuid, role text,
      revoked_at timestamptz, accepted_at timestamptz);
    create table automation_rules(organization_id uuid, trigger_event text,
      id uuid default gen_random_uuid(), is_active boolean default false);
    create function fn_role_at_least(uuid,text) returns boolean language sql as $$ select false $$;
    create function fn_is_platform_admin() returns boolean language sql as $$ select false $$;
    alter table automation_rules enable row level security;
    create policy automation_rules_test on automation_rules for all to authenticated using(true) with check(true);
    create function emit_event(text,text,uuid,jsonb,jsonb,uuid) returns uuid language sql as $$ select gen_random_uuid() $$;
    -- Apenas fixture reduzida: o harness CI exercita o trigger real do baseline.
    create function test_stage_status() returns trigger language plpgsql as $$ begin
      if exists(select 1 from crm_stages where id=new.stage_id and is_won) then new.status:='won'; end if;
      return new; end $$;
    create trigger test_stage_status before update of stage_id on crm_leads for each row execute function test_stage_status();
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261005190000_0229_obra_no_bolso_access.sql", import.meta.url), "utf8"));
  await db.exec(migration);
  // Fixture reduzida do envio; o CI mantém a prova com o baseline real.
  await db.exec(`
    create table channel_sessions(id uuid primary key,organization_id uuid,provider text,archived_at timestamptz);
    create table followup_flow_pointers(id uuid primary key,organization_id uuid);
    create table followup_enrollments(id uuid primary key,organization_id uuid,contact_id uuid,pointer_id uuid,status text);
    create table job_queue(id uuid primary key,organization_id uuid,contact_id uuid,kind text,payload jsonb);
    create table conversations(id uuid primary key,organization_id uuid,contact_id uuid,bot_silenced_until timestamptz);
    create table messages(id uuid primary key,organization_id uuid,contact_id uuid,direction text,created_at timestamptz);
    alter table contacts add column is_blocked boolean default false,add column force_human boolean default false,
      add column consent jsonb default '{}';
    alter table automation_rules add primary key(id),add column name text,add column actions jsonb default '[]',add column updated_at timestamptz default now();
    alter table event_log add column next_attempt_at timestamptz default now();
    create or replace function emit_event(text,text,uuid,jsonb,jsonb,uuid) returns uuid language plpgsql as $$
    declare eid uuid; begin
      insert into event_log(event_type,entity_kind,entity_id,payload,organization_id) values($1,$2,$3,$4,$6) returning id into eid;
      return eid; end $$;
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261008230000_0231_obra_subscription_outreach.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261009001000_0232_obra_outreach_message_storage.sql", import.meta.url), "utf8"));
  await db.query("insert into organizations values($1),($2)", [org, otherOrg]);
  await db.query("insert into crm_pipelines values($1,$2)", [pipeline, org]);
  await db.query("insert into crm_stages values($1,$2,$3,'Aberto',false,false),($4,$2,$3,'Acesso ativado',true,false)", [openStage, org, pipeline, wonStage]);
  await db.query("insert into obra_access_integrations(id,organization_id,pipeline_id,secret_encrypted,is_active,lifecycle_enabled) values($1,$2,$3,$4,true,true)", [integration, org, pipeline, secret]);
});
afterAll(async () => db.close());

it("preserva textos sem número, ao remover canal e ao reaplicar a atualização", async () => {
  const channel = randomUUID();
  await db.query("insert into channel_sessions values($1,$2,'waha',null)", [channel,org]);
  const messages = ["Meu cadastro", "Meu uso", "Meu suporte"];
  const save = async (number: string | null) => db.query(
    "select fn_configure_obra_outreach($1,$2,false,$3,null,$4,$5,$6)", [org,integration,number,...messages]);
  const read = async () => (await db.query<{ registration_message: string; usage_message: string; activation_message: string; outreach_enabled: boolean }>(
    "select registration_message,usage_message,activation_message,outreach_enabled from obra_access_integrations where id=$1", [integration])).rows[0];
  await save(null);
  expect(await read()).toEqual({ registration_message: messages[0],usage_message: messages[1],activation_message: messages[2],outreach_enabled: false });
  await save(channel);
  // Emula configuração anterior à 0232: texto nas ações, sem colunas preenchidas.
  await db.query("update obra_access_integrations set registration_message=null,usage_message=null,activation_message=null where id=$1", [integration]);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261009001000_0232_obra_outreach_message_storage.sql", import.meta.url), "utf8"));
  expect((await read())?.activation_message).toBe("Meu suporte");
  await save(null);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261009001000_0232_obra_outreach_message_storage.sql", import.meta.url), "utf8"));
  expect((await read())?.activation_message).toBe("Meu suporte");
  const rules = (await db.query<{ actions: unknown[]; is_active: boolean }>(
    "select actions,is_active from automation_rules where id=(select activation_rule_id from obra_access_integrations where id=$1)", [integration])).rows[0];
  expect(rules).toEqual({ actions: [],is_active: false });
  await expect(db.query("select fn_configure_obra_outreach($1,$2,true,null,null,'a','b','c')", [org,integration])).rejects.toThrow("obra_channel_required");
  // Campo vazio deve continuar vazio, inclusive após reapply.
  await db.query("select fn_configure_obra_outreach($1,$2,false,null,null,'a','b','')", [org,integration]);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20261009001000_0232_obra_outreach_message_storage.sql", import.meta.url), "utf8"));
  expect((await read())?.activation_message).toBe("");
});

it("agenda somente dois cuidados pelo início real e não repete por reconsulta", async () => {
  const channel = randomUUID();
  await db.query("insert into channel_sessions values($1,$2,'waha',null)", [channel,org]);
  await db.query("select fn_configure_obra_outreach($1,$2,true,$3,null,'Cadastro {{contact.name}}','Uso','Confirmada')", [org,integration,channel]);
  const o = await opportunity();
  const start = new Date(Date.now()-3*3600_000).toISOString(), fresh = new Date().toISOString();
  const event = { ...payload(o), event_type: "trial_started", em_trial: true, trial_started_at: start,
    occurred_at: fresh, checked_at: fresh, trial_ends_at: new Date(Date.parse(start)+72*3600_000).toISOString() };
  const result = await receive(event);
  await receive({ ...event, event_id: randomUUID() });
  const rows = (await db.query<{ kind: string; due_at: Date }>("select kind,due_at from obra_subscription_outreach where state_id=$1 order by due_at", [result.state_id])).rows;
  expect(rows.map(r=>r.kind)).toEqual(['registration','usage']);
  expect(new Date(rows[0]!.due_at).getTime()).toBe(Date.parse(start)+2*3600_000);
  expect(new Date(rows[1]!.due_at).getTime()).toBe(Date.parse(start)+48*3600_000);
  await db.query("select fn_configure_obra_outreach($1,$2,false,$3,null,'Cadastro','Uso','Confirmada')", [org,integration,channel]);
});

it("confirmação tem um único evento de mensagem e guarda bloqueia recusa/resposta/humano/outro tenant", async () => {
  const channel = randomUUID();
  await db.query("insert into channel_sessions values($1,$2,'waha',null)", [channel,org]);
  await db.query("select fn_configure_obra_outreach($1,$2,true,$3,null,'Cadastro','Uso','Confirmada')", [org,integration,channel]);
  const o = await opportunity(), fresh = new Date().toISOString();
  const event = { ...payload(o), occurred_at: fresh, checked_at: fresh };
  const result = await receive(event); await receive({ ...event, event_id: randomUUID() });
  const rows = (await db.query<{ event_id: string; rule_id: string }>("select event_id,rule_id from obra_subscription_outreach where state_id=$1 and kind='activation'", [result.state_id])).rows;
  expect(rows).toHaveLength(1);
  const item = rows[0]!;
  const live = async (tenant = org) => (await db.query<{ live: boolean }>("select fn_obra_outreach_send_live($1,$2,$3,$4) live", [tenant,item.event_id,o.contact,item.rule_id])).rows[0]!.live;
  const allowedWindow = (await db.query<{ allowed: boolean }>("select extract(isodow from now() at time zone 'America/Sao_Paulo') between 1 and 5 and extract(hour from now() at time zone 'America/Sao_Paulo')>=8 and extract(hour from now() at time zone 'America/Sao_Paulo')<20 allowed")).rows[0]!.allowed;
  expect(await live()).toBe(allowedWindow);
  expect(await live(otherOrg)).toBe(false);
  await db.query("update contacts set force_human=true where id=$1",[o.contact]); expect(await live()).toBe(false);
  await db.query("update contacts set force_human=false,consent='{\"marketing\":{\"declined_at\":\"yes\"}}' where id=$1",[o.contact]); expect(await live()).toBe(false);
  await db.query("update contacts set consent='{}' where id=$1",[o.contact]);
  await db.query("insert into messages values($1,$2,$3,'inbound',now()+interval '1 second')",[randomUUID(),org,o.contact]); expect(await live()).toBe(false);
  await db.query("select fn_configure_obra_outreach($1,$2,false,$3,null,'Cadastro','Uso','Confirmada')", [org,integration,channel]);
});

it("cuidados vencidos não acumulam e resposta retira o segmento sem rearmar", async () => {
  const channel = randomUUID();
  await db.query("insert into channel_sessions values($1,$2,'waha',null)",[channel,org]);
  await db.query("select fn_configure_obra_outreach($1,$2,true,$3,null,'Cadastro','Uso','Confirmada')",[org,integration,channel]);
  const o = await opportunity(), fresh = new Date().toISOString(), start = new Date(Date.now()-80*3600_000).toISOString();
  const event = { ...payload(o), event_type:'trial_started', em_trial:true, trial_started_at:start,
    occurred_at:fresh, checked_at:fresh, trial_ends_at:new Date(Date.parse(start)+72*3600_000).toISOString() };
  const result = await receive(event);
  expect((await db.query<{ n: number }>("select count(*)::int n from obra_subscription_outreach where state_id=$1",[result.state_id])).rows[0]!.n).toBe(0);
  await db.query("update contacts set tags=array['followup_assinatura'] where id=$1",[o.contact]);
  await db.query("insert into messages values($1,$2,$3,'inbound',now())",[randomUUID(),org,o.contact]);
  expect((await db.query<{ tags: string[] }>("select tags from contacts where id=$1",[o.contact])).rows[0]!.tags).not.toContain('followup_assinatura');
  await db.query("update contacts set tags=array['followup_assinatura'],force_human=true where id=$1",[o.contact]);
  expect((await db.query<{ tags: string[] }>("select tags from contacts where id=$1",[o.contact])).rows[0]!.tags).not.toContain('followup_assinatura');
  await db.query("select fn_configure_obra_outreach($1,$2,false,$3,null,'Cadastro','Uso','Confirmada')",[org,integration,channel]);
});

it("configuração não usa número ou fluxo de outro workspace", async () => {
  const channel = randomUUID(), pointer = randomUUID();
  await db.query("insert into channel_sessions values($1,$2,'waha',null)",[channel,otherOrg]);
  await db.query("insert into followup_flow_pointers values($1,$2)",[pointer,otherOrg]);
  await expect(db.query("select fn_configure_obra_outreach($1,$2,true,$3,null,'a','b','c')",[org,integration,channel])).rejects.toThrow('obra_channel_invalid');
  await expect(db.query("select fn_configure_obra_outreach($1,$2,false,null,$3,'a','b','c')",[org,integration,pointer])).rejects.toThrow('obra_recovery_invalid');
});

it("ativo no início do teste mantém oportunidade aberta", async () => {
  const o = await opportunity(), event = { ...payload(o), event_type: "trial_started", checked_at: started, occurred_at: started };
  expect(await receive(event)).toMatchObject({ status: "accepted", decision: "trial", event_id: event.event_id });
  expect(await leadStatus(o.lead)).toBe("open");
  expect((await state(event.product_user_id)).converted_at).toBeNull();
});

it("consulta antecipada não gera recibo nem fechamento", async () => {
  const o = await opportunity(), event = payload(o);
  event.checked_at = new Date(Date.parse(checked) - 1000).toISOString();
  expect(await receive(event)).toMatchObject({ status: "invalid_event" });
  expect(await leadStatus(o.lead)).toBe("open");
});

it("confirma exatamente após 96 horas uma vez; reenvio e conflito são distintos", async () => {
  const o = await opportunity(), event = payload(o);
  expect(await receive(event)).toMatchObject({ status: "accepted", decision: "paid" });
  expect(await receive(event)).toMatchObject({ status: "duplicate", event_id: event.event_id });
  expect(await receive(event, { fingerprint: "b".repeat(64) })).toMatchObject({ status: "conflict" });
  expect(await leadStatus(o.lead)).toBe("won");
  expect((await db.query<{ n: number }>("select count(*)::int n from crm_lead_activities where lead_id=$1", [o.lead])).rows[0]!.n).toBe(1);
});

it.each([
  ["ativo", true, true, "manual"], ["suspenso", true, false, "recover"],
  ["cancelado", false, false, "recover"], ["suspenso", false, true, "manual"],
  ["gratis", false, true, "manual"],
] as const)("%s/trial=%s/acesso=%s -> %s", async (status_pagamento, em_trial, access_enabled, decision) => {
  const o = await opportunity(), event = { ...payload(o), status_pagamento, em_trial, access_enabled };
  expect(await receive(event)).toMatchObject({ status: "accepted", decision });
  expect(await leadStatus(o.lead)).toBe("open");
});

it("suspensão depois de conversão preserva venda e exige suporte, sem recuperação", async () => {
  const o = await opportunity(), event = payload(o);
  await receive(event);
  const converted = (await state(event.product_user_id)).converted_at;
  await db.query("update contacts set tags=array['followup_assinatura'] where id=$1", [o.contact]);
  expect(await receive({ ...event, event_id: randomUUID(), status_pagamento: "suspenso", access_enabled: false,
    checked_at: new Date(Date.parse(checked) + 1000).toISOString(), occurred_at: new Date(Date.parse(checked) + 1000).toISOString() }))
    .toMatchObject({ decision: "post_conversion" });
  expect((await state(event.product_user_id)).converted_at).toEqual(converted);
  expect(await leadStatus(o.lead)).toBe("won");
  expect((await db.query<{ tags: string[] }>("select tags from contacts where id=$1", [o.contact])).rows[0]!.tags).toEqual([]);
});

it("eventos atrasados e mudança do início do teste não sobrescrevem confirmação", async () => {
  const o = await opportunity(), event = payload(o);
  await receive(event);
  expect(await receive({ ...event, event_id: randomUUID(), event_type: "trial_started" }))
    .toMatchObject({ decision: "ignored", reason: "initial_event_after_snapshot" });
  expect(await receive({ ...event, event_id: randomUUID(), trial_started_at: new Date(Date.parse(started) - 1000).toISOString() }))
    .toMatchObject({ decision: "ignored", reason: "trial_start_changed" });
  expect((await state(event.product_user_id)).decision).toBe("paid");
});

it("identidade ambígua ou contato já vinculado nunca fecham segunda venda", async () => {
  const o = await opportunity(), first = payload(o);
  await receive(first);
  expect(await receive(payload(o))).toMatchObject({ decision: "manual", reason: "identity_already_linked" });
  const other = await opportunity();
  expect(await receive({ ...payload(other), email: o.email })).toMatchObject({ decision: "manual", reason: "contact_identity_conflict" });
  expect(await leadStatus(other.lead)).toBe("open");
});

it("organização, segredo e opt-in são checados no banco", async () => {
  const o = await opportunity(), event = payload(o);
  expect(await receive(event, { org: otherOrg })).toMatchObject({ status: "configuration_error" });
  expect(await receive(event, { secret: new Uint8Array([9]) })).toMatchObject({ status: "configuration_error" });
  await db.query("update obra_access_integrations set is_active=false where id=$1", [integration]);
  try { expect(await receive(event)).toMatchObject({ status: "configuration_error" }); }
  finally { await db.query("update obra_access_integrations set is_active=true where id=$1", [integration]); }
  expect(await leadStatus(o.lead)).toBe("open");
});

it("modo não pode mudar depois do histórico e migração é idempotente", async () => {
  await db.query("update obra_access_integrations set is_active=false where id=$1", [integration]);
  await expect(db.query("update obra_access_integrations set lifecycle_enabled=false where id=$1", [integration])).rejects.toThrow("obra_configuration_locked");
  await db.exec(migration);
  await db.query("update obra_access_integrations set is_active=true where id=$1", [integration]);
  expect((await db.query<{ n: number }>("select count(*)::int n from obra_subscription_states")).rows[0]!.n).toBeGreaterThan(0);
});

it("anonimização rompe vínculos e não permite restaurar conversão nem mensagens", async () => {
  const o = await opportunity(), event = payload(o);
  await receive(event);
  await db.query("update contacts set is_anonymized=true where id=$1", [o.contact]);
  const row = (await db.query<{ contact_id: string | null; lead_id: string | null; decision: string }>(
    "select contact_id,lead_id,decision from obra_subscription_states where product_user_id=$1", [event.product_user_id])).rows[0]!;
  expect(row).toEqual({ contact_id: null, lead_id: null, decision: "post_conversion" });
  expect(await receive({ ...event, event_id: randomUUID() })).toMatchObject({ decision: "post_conversion" });
});
