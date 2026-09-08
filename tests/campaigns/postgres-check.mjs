// Banco descartavel, loopback apenas. Nao le .env nem aceita URL de banco.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const modulePath = process.env.CAMPAIGNS_EMBEDDED_PG;
const tempRoot = process.env.CAMPAIGNS_TEST_TEMP;
if (!modulePath || !tempRoot) throw new Error("Set CAMPAIGNS_EMBEDDED_PG and CAMPAIGNS_TEST_TEMP to disposable local paths.");
const { default: EmbeddedPostgres } = await import(pathToFileURL(modulePath).href);
const cluster = new EmbeddedPostgres({ databaseDir: join(mkdtempSync(join(tempRoot, "campaigns-")), "db"),
  user: "postgres", password: "campaigns-local-test", port: 55439, persistent: false,
  postgresFlags: ["-h", "127.0.0.1"], onLog() {}, onError() {},
});
const config = { host: "127.0.0.1", port: 55439, user: "postgres", password: "campaigns-local-test", database: "postgres" };
let db;
const orgA = randomUUID(), orgB = randomUUID(), user = randomUUID(), channelB = randomUUID();
const contactA = randomUUID(), contactB = randomUUID(), contactOtherSource = randomUUID();
const migration = readFileSync(new URL("../../supabase/migrations/20260907120000_0218_whatsapp_campaigns.sql", import.meta.url), "utf8");

before(async () => {
  await cluster.initialise(); await cluster.start();
  db = new Client(config); await db.connect();
  await db.query(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table organizations(id uuid primary key);
    create table contacts(id uuid primary key, organization_id uuid not null references organizations,
      tags text[], source text, is_merged_into uuid);
    create table channel_sessions(id uuid primary key, organization_id uuid not null references organizations,
      archived_at timestamptz, status text);
    create table messages(id uuid primary key, organization_id uuid not null, contact_id uuid not null);
    create table event_log(id uuid primary key default gen_random_uuid(), organization_id uuid, entity_id uuid,
      event_type text, entity_kind text, payload jsonb default '{}'::jsonb, metadata jsonb default '{}'::jsonb,
      next_attempt_at timestamptz, status text default 'pending');
    create function fn_user_org_ids() returns setof uuid language sql as
      $$ select nullif(current_setting('test.org', true), '')::uuid $$;
    create function fn_role_at_least(uuid, text) returns boolean language sql as $$ select true $$;
    create function emit_event(text,text,uuid,jsonb,jsonb,uuid) returns uuid language plpgsql as $$
      declare v uuid;
      begin
        if current_setting('test.fail_event', true) = 'yes' then raise exception 'event_failed'; end if;
        insert into event_log(organization_id, entity_id, event_type) values ($6,$3,$1) returning id into v;
        return v;
      end $$;
    grant usage on schema public to authenticated;
  `);
  await db.query(migration);
  await db.query("insert into organizations values ($1),($2)", [orgA, orgB]);
  await db.query("insert into auth.users values ($1)", [user]);
  await db.query("insert into channel_sessions values ($1,$2,null,'WORKING')", [channelB, orgB]);
  await db.query("insert into contacts values ($1,$2,array['vip'],'manual',null),($3,$4,array['vip'],'manual',null),($5,$2,array['vip'],'whatsapp',null)", [contactA, orgA, contactB, orgB, contactOtherSource]);
});
after(async () => { await db?.end(); await cluster.stop(); });

const oneStep = [{ message: "Literal", delay_minutes: 0 }];
const twoSteps = [{ message: "Literal", delay_minutes: 0 }, { message: "Second", delay_minutes: 60 }];

async function freshChannel(org = orgA) {
  const c = randomUUID();
  await db.query("insert into channel_sessions values ($1,$2,null,'WORKING')", [c, org]);
  return c;
}
async function launch({ id = randomUUID(), org = orgA, channel = null, filters = { tag: "vip", source: "manual" }, limit = 10000, steps = twoSteps } = {}) {
  const ch = channel ?? await freshChannel(org);
  await db.query("select launch_whatsapp_campaign($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)", [id, org, user, "Test", ch, JSON.stringify(steps), JSON.stringify(filters), limit]);
  return id;
}
async function claim(campaign, org = orgA, step = 0, contact = null) {
  return (await db.query("select claim_whatsapp_campaign_step($1,$2,$3,$4) as claim", [org, campaign, step, contact])).rows[0].claim;
}
async function finalize(campaign, contact, step, status) {
  return (await db.query("select finalize_whatsapp_campaign_step($1,$2,$3,$4,$5) as ok", [orgA, campaign, contact, step, status])).rows[0].ok;
}
async function ageReservations(campaign) {
  await db.query("update whatsapp_campaign_recipient_steps set reserved_at = now() - interval '1 hour' where campaign_id=$1 and reserved_at is not null", [campaign]);
}

test("migration is idempotent and baseline append is identical", async () => {
  await db.query(migration);
  const baseline = readFileSync(new URL("../../supabase/baseline.sql", import.meta.url), "utf8");
  assert.equal(baseline.split("-- ---- whatsapp_campaigns (migration 0218) ----\n")[1].trim(), migration.trim());
});
test("launch freezes tag + source audience, seeds step 0 and emits one event on replay", async () => {
  const id = await launch();
  await launch({ id });
  const recipients = await db.query("select contact_id from whatsapp_campaign_recipients where campaign_id=$1", [id]);
  assert.deepEqual(recipients.rows, [{ contact_id: contactA }]);
  assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipient_steps where campaign_id=$1 and step_index=0", [id])).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int n from event_log where entity_id=$1", [id])).rows[0].n, 1);
  await db.query("update contacts set tags='{}' where id=$1", [contactA]);
  assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipients where campaign_id=$1", [id])).rows[0].n, 1);
  await db.query("update contacts set tags=array['vip'] where id=$1", [contactA]);
});
test("source is optional and merged contacts are excluded", async () => {
  const merged = randomUUID();
  await db.query("insert into contacts values($1,$2,array['vip'],'manual',$3)", [merged, orgA, contactA]);
  const id = await launch({ filters: { tag: "vip" } });
  assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipients where campaign_id=$1", [id])).rows[0].n, 2);
});
test("invalid steps are rejected before creating campaign", async () => {
  await assert.rejects(launch({ steps: [] }), /invalid_steps/);
  await assert.rejects(launch({ steps: [{ message: "  ", delay_minutes: 0 }] }), /invalid_steps/);
  await assert.rejects(launch({ steps: [{ message: "x", delay_minutes: -1 }] }), /invalid_steps/);
});
test("event failure rolls back campaign, recipients and step 0", async () => {
  const id = randomUUID();
  await db.query("set test.fail_event='yes'");
  await assert.rejects(launch({ id }), /event_failed/);
  await db.query("set test.fail_event='no'");
  assert.equal((await db.query("select count(*)::int n from whatsapp_campaigns where id=$1", [id])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipients where campaign_id=$1", [id])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipient_steps where campaign_id=$1", [id])).rows[0].n, 0);
});
test("foreign channel is rejected before creating campaign", async () => {
  await assert.rejects(launch({ channel: channelB }), /invalid_channel/);
});
test("unique campaign/contact and campaign/contact/step, tenant-consistent FKs", async () => {
  const id = await launch();
  await assert.rejects(db.query("insert into whatsapp_campaign_recipients(organization_id,campaign_id,contact_id) values($1,$2,$3)", [orgA, id, contactA]), { code: "23505" });
  await assert.rejects(db.query("insert into whatsapp_campaign_recipient_steps(organization_id,campaign_id,contact_id,step_index) values($1,$2,$3,0)", [orgA, id, contactA]), { code: "23505" });
  await assert.rejects(db.query("insert into whatsapp_campaign_recipients(organization_id,campaign_id,contact_id) values($1,$2,$3)", [orgA, id, contactB]), { code: "23503" });
  const message = randomUUID();
  await db.query("insert into messages values($1,$2,$3)", [message, orgB, contactB]);
  await assert.rejects(db.query("update whatsapp_campaign_recipient_steps set message_id=$1 where campaign_id=$2", [message, id]), { code: "23503" });
});
test("RLS isolates two tenants and authenticated cannot launch, claim or mutate", async () => {
  await launch({ org: orgB, channel: channelB });
  await db.query("select set_config('test.org',$1,false)", [orgA]);
  await db.query("set role authenticated");
  try {
    const campaigns = await db.query("select organization_id from whatsapp_campaigns");
    assert.ok(campaigns.rowCount > 0);
    assert.ok(campaigns.rows.every((r) => r.organization_id === orgA));
    const steps = await db.query("select organization_id from whatsapp_campaign_recipient_steps");
    assert.ok(steps.rows.every((r) => r.organization_id === orgA));
    await assert.rejects(db.query("update whatsapp_campaign_recipient_steps set status='sent'"), { code: "42501" });
    await assert.rejects(launch(), { code: "42501" });
    await assert.rejects(db.query("select claim_whatsapp_campaign_step($1,$2,0)", [orgA, randomUUID()]), { code: "42501" });
  } finally { await db.query("reset role"); }
});
test("next step with delay schedules a future event and is idempotent on replay", async () => {
  const id = await launch();
  const first = await claim(id, orgA, 0);
  assert.ok(first.step_id);
  assert.equal((await finalize(id, first.contact_id, 0, "sent")), true);
  const step1 = await db.query("select status from whatsapp_campaign_recipient_steps where campaign_id=$1 and step_index=1", [id]);
  assert.equal(step1.rows.length, 1);
  assert.equal(step1.rows[0].status, "pending");
  const events = await db.query("select next_attempt_at from event_log where entity_id=$1 and payload->>'step_index'='1'", [id]);
  assert.equal(events.rows.length, 1);
  const due = new Date(events.rows[0].next_attempt_at);
  assert.ok(due > new Date(Date.now() + 50 * 60 * 1000) && due < new Date(Date.now() + 70 * 60 * 1000));
  // Replay nao cria segundo passo nem segundo evento.
  assert.equal((await finalize(id, first.contact_id, 0, "sent")), false);
  assert.equal((await db.query("select count(*)::int n from event_log where entity_id=$1 and payload->>'step_index'='1'", [id])).rows[0].n, 1);
});
test("opt-out and reply stop do not schedule the next step", async () => {
  for (const status of ["skipped_opt_out", "stopped_reply"]) {
    const id = await launch();
    const first = await claim(id, orgA, 0);
    await finalize(id, first.contact_id, 0, status);
    assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipient_steps where campaign_id=$1 and step_index=1", [id])).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from event_log where entity_id=$1 and payload->>'step_index'='1'", [id])).rows[0].n, 0);
  }
});
test("per-contact claim targets exactly one step and replay is done", async () => {
  const id = await launch();
  const first = await claim(id, orgA, 0);
  assert.ok(first.step_id);
  await finalize(id, first.contact_id, 0, "sent");
  await ageReservations(id);
  const step1 = await claim(id, orgA, 1, first.contact_id);
  assert.ok(step1.step_id);
  assert.equal(step1.contact_id, first.contact_id);
  const again = await claim(id, orgA, 1, first.contact_id);
  assert.ok(again.done);
});
test("rolling hour quota is atomic across 16 concurrent sessions", async () => {
  const id = await launch({ filters: { tag: "vip" }, limit: 1, steps: oneStep });
  const clients = Array.from({ length: 16 }, () => new Client(config));
  try {
    await Promise.all(clients.map((c) => c.connect()));
    const results = await Promise.all(clients.map((c) => c.query("select claim_whatsapp_campaign_step($1,$2,0) as claim", [orgA, id])));
    assert.equal(results.filter((r) => r.rows[0].claim.step_id).length, 1);
    assert.equal(results.filter((r) => r.rows[0].claim.retry_at).length, 15);
    assert.equal((await db.query("select count(*)::int n from whatsapp_campaign_recipient_steps where campaign_id=$1 and reserved_at is not null", [id])).rows[0].n, 1);
    await db.query("update whatsapp_campaign_recipient_steps set reserved_at=now()-interval '30 minutes' where campaign_id=$1 and reserved_at is not null", [id]);
    const capped = await Promise.all(clients.map((c) => c.query("select claim_whatsapp_campaign_step($1,$2,0) as claim", [orgA, id])));
    assert.equal(capped.filter((r) => r.rows[0].claim.step_id).length, 0);
    assert.equal(capped.filter((r) => r.rows[0].claim.retry_at).length, 16);
    await db.query("update whatsapp_campaign_recipient_steps set reserved_at=now()-interval '1 hour 1 second' where campaign_id=$1 and reserved_at is not null", [id]);
    const next = await db.query("select claim_whatsapp_campaign_step($1,$2,0) as claim", [orgA, id]);
    assert.ok(next.rows[0].claim.step_id);
  } finally { await Promise.all(clients.map((c) => c.end())); }
});
test("hourly limit is shared across campaigns on the same channel", async () => {
  const ch = await freshChannel();
  const a = await launch({ channel: ch, limit: 1, steps: oneStep });
  const b = await launch({ channel: ch, limit: 1, steps: oneStep });
  const firstA = await claim(a, orgA, 0);
  assert.ok(firstA.step_id);
  const firstB = await claim(b, orgA, 0);
  assert.ok(firstB.retry_at);
  await db.query("update whatsapp_campaign_recipient_steps set reserved_at=now()-interval '1 hour 1 second' where campaign_id=$1", [a]);
  const againB = await claim(b, orgA, 0);
  assert.ok(againB.step_id);
});
test("different channels have independent hourly limits", async () => {
  const ch1 = await freshChannel(); const ch2 = await freshChannel();
  const a = await launch({ channel: ch1, limit: 1, steps: oneStep });
  const b = await launch({ channel: ch2, limit: 1, steps: oneStep });
  const firstA = await claim(a, orgA, 0);
  const firstB = await claim(b, orgA, 0);
  assert.ok(firstA.step_id);
  assert.ok(firstB.step_id);
});
test("durable uncertain and sent steps are never reclaimed, including foreign tenant claims", async () => {
  const id = await launch();
  assert.equal((await claim(id, orgB, 0)).done, true);
  const first = await claim(id, orgA, 0);
  assert.ok(first.step_id);
  const state = (await db.query("select status,failure_reason from whatsapp_campaign_recipient_steps where id=$1", [first.step_id])).rows[0];
  assert.equal(state.status, "failed"); assert.equal(state.failure_reason, "send_uncertain_manual_inspection");
  assert.equal((await claim(id, orgA, 0)).done, true);
  await db.query("update whatsapp_campaign_recipient_steps set status='sent' where id=$1", [first.step_id]);
  assert.equal((await claim(id, orgA, 0)).done, true);
});
