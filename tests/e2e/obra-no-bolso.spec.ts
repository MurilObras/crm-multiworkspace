import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { loginComoAdmin } from "./helpers/login-admin";

// Banco/Auth locais, sem worker nem transporte externo. O contrato/HMAC é
// coberto separadamente; aqui o ledger é semeado pelo RPC real do banco.
const api = "/api/v1/integrations/obra-no-bolso";
const prefix = `E2E-OBRA-${randomUUID().slice(0, 8)}`;
const email = `${prefix.toLowerCase()}@example.invalid`;
const phone = `+1202${String(randomBytes(4).readUInt32BE() % 10_000_000).padStart(7, "0")}`;
let db: pg.Pool;
let creds: { org_id: string; org_slug: string; supabase_url: string; password: string;
  users: Record<string, { email: string }>; admin_totp: { secret: string } };
let pipeline: string, contact: string, lead: string, otherLead: string, integration: string, session: string;
function local(value: string | undefined): boolean {
  return Boolean(value && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname));
}

test.beforeAll(async () => {
  if (!local(process.env.SUPABASE_DB_URL) || !local(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    throw new Error("PostgreSQL e Supabase Auth locais obrigatórios");
  }
  creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8"));
  if (creds.org_slug !== "e2e-test-org" || !local(creds.supabase_url)) throw new Error("Fixture local obrigatória");
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL });
  await db.query("insert into private.app_secrets(name,value) values('nuvemshop_oauth_key',$1) on conflict(name) do nothing",
    [randomBytes(32).toString("hex")]);
  pipeline = (await db.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,$2,$3,2000) returning id",
    [creds.org_id, prefix, prefix.toLowerCase()])).rows[0].id;
  const open = (await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Aberto','aberto',1000) returning id",
    [creds.org_id, pipeline])).rows[0].id;
  await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position,is_won) values($1,$2,'Acesso ativado','acesso-ativado',2000,true)",
    [creds.org_id, pipeline]);
  contact = (await db.query("insert into contacts(organization_id,name,email,phone_number) values($1,$2,$3,$4) returning id",
    [creds.org_id, prefix, email, phone])).rows[0].id;
  const leads = (await db.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5),($1,$2,$3,$4,$6) returning id",
    [creds.org_id, pipeline, open, contact, `${prefix} principal`, `${prefix} alternativa`])).rows;
  lead = leads[0].id; otherLead = leads[1].id;
  session = (await db.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'STOPPED',$3) returning id",
    [creds.org_id, prefix, Buffer.from("synthetic-unused")])).rows[0].id;
});

test.afterAll(async () => {
  if (!db) return;
  try {
    // Remove somente fixtures deste teste; chave compartilhada e demais dados ficam.
    await db.query("delete from obra_access_links where organization_id=$1 and receipt_id in(select id from obra_access_receipts where integration_id=$2)", [creds.org_id, integration]);
    await db.query("delete from obra_access_receipts where integration_id=$1", [integration]);
    await db.query("delete from obra_access_integrations where id=$1", [integration]);
    await db.query("delete from automation_rules where organization_id=$1 and name=$2", [creds.org_id, prefix]);
    await db.query("delete from crm_leads where id=any($1::uuid[])", [[lead, otherLead]]);
    await db.query("delete from contacts where id=$1", [contact]);
    await db.query("delete from channel_sessions where id=$1", [session]);
    await db.query("delete from crm_stages where pipeline_id=$1", [pipeline]);
    await db.query("delete from crm_pipelines where id=$1", [pipeline]);
  } finally { await db.end(); }
});

test("admin configura inativa, encontra pendência antiga e confirma uma única oportunidade sem enviar", async ({ page }) => {
  test.setTimeout(180_000);
  await loginComoAdmin(page, creds);
  await page.goto("/app/webhooks");
  await page.getByRole("tab", { name: "Obra no Bolso", exact: true }).click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: prefix, exact: true }).click();
  const createdResponse = page.waitForResponse(response => response.url().endsWith(api) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Criar integração desligada", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const configured = (await created.json()).data;
  integration = configured.integration.id;
  expect(configured.integration.is_active).toBe(false);
  await expect(page.getByLabel("Segredo de assinatura")).toBeVisible();
  const query = await page.request.get(api);
  const config = (await query.json()).data;
  expect(config.integration.secret_encrypted).toBeUndefined();
  expect(config.signing_secret).toBeUndefined();
  await page.reload();
  await page.getByRole("tab", { name: "Obra no Bolso", exact: true }).click();
  await expect(page.getByLabel("Segredo de assinatura")).toHaveCount(0);
  await expect(page.getByText("Inativa", { exact: true })).toBeVisible();

  // Regra criada pelo endpoint verdadeiro, sem ativá-la nem conectar um canal.
  const ruleResponse = await page.request.post("/api/v1/automation-rules", { headers: { Origin: new URL(page.url()).origin }, data: {
    name: prefix, trigger_event: "obra_access.activated", conditions: [{ field: "event.modality", op: "eq", value: "paid" }],
    actions: [{ type: "send_whatsapp_message", config: { channel_session_id: session, template: "Parabéns pelo acesso pago!" } }],
  } });
  expect(ruleResponse.status()).toBe(201);
  expect((await ruleResponse.json()).data.is_active).toBe(false);
  await page.getByRole("button", { name: "Ativar conexão", exact: true }).click();
  await expect(page.getByText("Ativa", { exact: true })).toBeVisible();
  const secret = (await db.query("select secret_encrypted from obra_access_integrations where id=$1", [integration])).rows[0].secret_encrypted;
  const event = { version: 1, event_type: "first_access_granted", event_id: prefix, product_user_id: prefix,
    occurred_at: new Date().toISOString(), user_created_at: new Date(Date.now() - 60_000).toISOString(),
    phone, name: prefix, email, plan: "Pro", modality: "paid", provider: "asaas", user_status: "active", is_new_user: true,
    trial_active: false, trial_ends_at: null };
  const receive = (payload: typeof event, rejection: string | null = null) => db.query(
    "select fn_receive_obra_access($1,$2,$3::jsonb,$4,$5::text[],$6,$7) result",
    [creds.org_id, integration, payload, "a".repeat(64), [phone], rejection, secret]);
  const pending = (await receive(event)).rows[0].result;
  expect(pending).toMatchObject({ status: "pending", reason: "multiple_open_leads" });
  for (let i = 0; i < 55; i++) await receive({ ...event, event_id: `${prefix}-${i}`, product_user_id: `${prefix}-${i}` }, "paid_user_not_eligible");
  await page.getByRole("button", { name: "Atualizar histórico", exact: true }).click();
  await expect(page.getByText("Pendente de conferência", { exact: true })).toHaveCount(0);
  await page.getByLabel("Filtrar eventos").click();
  await page.getByRole("option", { name: "Pendentes", exact: true }).click();
  await expect(page.getByText(/Mais de uma oportunidade aberta/)).toBeVisible();
  await page.getByRole("button", { name: "Conferir associação", exact: true }).click();
  const review = page.getByRole("region", { name: "Conferir evento pendente" });
  await review.getByRole("button", { name: "Buscar", exact: true }).click();
  await review.getByRole("combobox").first().click();
  await page.getByRole("option", { name: new RegExp(prefix) }).click();
  await review.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: `${prefix} principal`, exact: true }).click();
  const confirmation = page.waitForResponse(response => response.url().endsWith(`/receipts/${pending.receipt_id}/associate`));
  await review.getByRole("button", { name: "Confirmar associação", exact: true }).click();
  expect((await (await confirmation).json()).data.status).toBe("processed");
  expect((await db.query("select status from crm_leads where id=$1", [lead])).rows[0].status).toBe("won");
  expect((await db.query("select status from crm_leads where id=$1", [otherLead])).rows[0].status).toBe("open");
  expect((await receive(event)).rows[0].result.original_status).toBe("processed");
  expect((await db.query("select count(*)::int n from event_log where organization_id=$1 and event_type='obra_access.activated' and entity_id=$2", [creds.org_id, lead])).rows[0].n).toBe(1);
  expect((await db.query("select count(*)::int n from messages where organization_id=$1 and contact_id=$2 and direction='outbound'", [creds.org_id, contact])).rows[0].n).toBe(0);
  expect((await db.query("select metadata from api_audit_log where action='obra_access.manual_link' and resource_id=$1", [pending.receipt_id])).rows).toHaveLength(1);
});
