import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Prova de idempotência de escrita sobre o ambiente REAL do E2E (Supabase:
 * PostgREST + GoTrue + Postgres), sem simulador de PostgREST. Usa as rotas
 * reais (`POST /api/v1/messages`, `POST /api/v1/automation-rules`), autenticação
 * real (login) e conta registros diretamente no banco via `pg`. O transporte
 * externo (WhatsApp/WAHA) não existe no rig — o que se prova é a GARANTIA DO
 * CRM: uma chave → um recurso, sem nova tentativa.
 */
const dbUrl = process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
function local(value: string | undefined) {
  if (!value) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
}
const app = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const prefix = `E2E-IDEM-${randomUUID().slice(0, 8)}`;
let db: pg.Pool;
let creds: { org_id: string; org_slug: string; supabase_url: string; password: string; users: Record<string, { email: string }> };
let session: string, conversation: string;
let managerId: string;

test.describe("Kiwify: idempotência de escrita (rotas reais)", () => {
  test.setTimeout(180000);

  test.beforeAll(async () => {
    if (!local(dbUrl) || !local(supabaseUrl)) throw new Error("Prepare PostgreSQL e Supabase Auth locais para o E2E");
    creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8"));
    if (creds.org_slug !== "e2e-test-org" || !local(creds.supabase_url)) throw new Error("Credenciais sintéticas do rig local obrigatórias");
    db = new pg.Pool({ connectionString: dbUrl });
    const org = creds.org_id;
    managerId = (await db.query("select id from auth.users where email=$1", [creds.users.manager!.email])).rows[0].id;
    session = (await db.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit) values($1,$2,'WORKING',$3,300) returning id", [org, prefix, Buffer.from("synthetic-unused")])).rows[0].id;
    const contact = (await db.query("insert into contacts(organization_id,name,phone_number) values($1,'Idem sintético','+12025550199') returning id", [org])).rows[0].id;
    conversation = (await db.query("insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at) values($1,$2,$3,'open',now()) returning id", [org, contact, session])).rows[0].id;
  });

  test.afterAll(async () => {
    if (!db) return;
    try {
      await db.query("delete from idempotency_keys where key like $1", [`%:${prefix}%`]);
      await db.query("delete from automation_rules where name like $1", [`${prefix}%`]);
      await db.query("delete from messages where conversation_id=$1", [conversation]);
      await db.query("delete from conversations where id=$1", [conversation]);
      await db.query("delete from contacts where organization_id=$1 and phone_number='+12025550199'", [creds.org_id]);
      await db.query("delete from channel_sessions where id=$1", [session]);
    } finally {
      await db.end();
    }
  });

  async function login(page: Page): Promise<void> {
    await page.goto(`${app}/login`);
    await page.locator("#email").fill(creds.users.manager!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/app\//);
  }

  async function postMessage(page: Page, key: string, body: string) {
    return page.request.post(`${app}/api/v1/messages`, {
      headers: { "Idempotency-Key": key },
      data: { conversation_id: conversation, type: "text", body },
    });
  }
  async function postRule(page: Page, key: string, name: string) {
    return page.request.post(`${app}/api/v1/automation-rules`, {
      headers: { "Idempotency-Key": key },
      data: {
        name,
        trigger_event: "lead.created",
        conditions: [],
        actions: [{ type: "send_whatsapp_message", config: { channel_session_id: session, template: "Oi" } }],
      },
    });
  }
  const countMessages = async (key: string) =>
    (await db.query("select count(*)::int n from messages where conversation_id=$1 and metadata->>'idempotency_key' like $2", [conversation, `%:${key}`])).rows[0].n;
  const countRules = async (name: string) => (await db.query("select count(*)::int n from automation_rules where name=$1", [name])).rows[0].n;

  test("A: requisições simultâneas mesma chave/payload → uma mensagem e uma regra", async ({ page }) => {
    await login(page);
    const mkey = `${prefix}-A-m`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => postMessage(page, mkey, "Oi concorrencia")));
    expect(responses.every((r) => r.ok())).toBe(true);
    expect(await countMessages(mkey)).toBe(1);

    const rkey = `${prefix}-A-r`;
    const ruleName = `${prefix} A`;
    const rr = await Promise.all(Array.from({ length: 8 }, () => postRule(page, rkey, ruleName)));
    expect(rr.every((r) => r.ok())).toBe(true);
    expect(await countRules(ruleName)).toBe(1);
    expect((await db.query("select is_active from automation_rules where name=$1", [ruleName])).rows[0].is_active).toBe(false);
  });

  test("B: mesma chave com payload diferente → 409 sem novo efeito", async ({ page }) => {
    await login(page);
    const key = `${prefix}-B`;
    const r1 = await postMessage(page, key, "payload um");
    expect(r1.status()).toBe(201);
    const r2 = await postMessage(page, key, "payload dois");
    expect(r2.status()).toBe(409);
    expect(await countMessages(key)).toBe(1);
  });

  test("C: resposta perdida após persistência → retry recupera o mesmo recurso", async ({ page }) => {
    await login(page);
    const key = `${prefix}-C`;
    const r1 = await postMessage(page, key, "Oi resposta perdida");
    const id1 = (await r1.json()).data.id;
    expect(r1.status()).toBe(201);
    const r2 = await postMessage(page, key, "Oi resposta perdida");
    expect(r2.ok()).toBe(true);
    expect((await r2.json()).data.id).toBe(id1);
    expect(await countMessages(key)).toBe(1);
  });

  test("D: transporte potencialmente aceito sem confirmação → retries não criam nova tentativa", async ({ page }) => {
    await login(page);
    const key = `${prefix}-D`;
    await postMessage(page, key, "Oi incerto");
    await db.query("update messages set status='sent', external_id=$2 where conversation_id=$1 and metadata->>'idempotency_key' like $3", [conversation, `synthetic-${randomUUID()}`, `%:${key}`]);
    const before = await countMessages(key);
    for (let i = 0; i < 4; i++) await postMessage(page, key, "Oi incerto");
    expect(await countMessages(key)).toBe(before);
  });

  test("E: limpeza preserva conflito e o payload original ainda recupera", async ({ page }) => {
    await login(page);
    const key = `${prefix}-E`;
    const chave = `${managerId}:${key}`;
    const endpoint = "/api/v1/messages";
    const r1 = await postMessage(page, key, "payload original");
    const original = await r1.json();
    const id1 = original.data.id;
    expect(r1.status()).toBe(201);
    // a reserva correta existe (uma, com org+endpoint+key)
    expect((await db.query("select count(*)::int n from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [creds.org_id, endpoint, chave])).rows[0].n).toBe(1);
    // limpeza com os MESMOS filtros
    await db.query("delete from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [creds.org_id, endpoint, chave]);
    expect((await db.query("select count(*)::int n from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [creds.org_id, endpoint, chave])).rows[0].n).toBe(0);
    // payload DIFERENTE → 409 (hash durável no recurso), sem novo recurso
    const r2 = await postMessage(page, key, "payload diferente");
    expect(r2.status()).toBe(409);
    expect(await countMessages(key)).toBe(1);
    // payload ORIGINAL → recupera a MESMA mensagem, com resposta completa
    const r3 = await postMessage(page, key, "payload original");
    const replay = await r3.json();
    expect(replay.data.id).toBe(id1);
    expect(replay.data.status).toBeTruthy();
    expect(await countMessages(key)).toBe(1);
  });

  test("F: nova operação deliberada com outra chave → segundo recurso", async ({ page }) => {
    await login(page);
    const a = await postMessage(page, `${prefix}-F-a`, "mesmo texto");
    const b = await postMessage(page, `${prefix}-F-b`, "mesmo texto");
    expect((await a.json()).data.id).not.toBe((await b.json()).data.id);
  });

  test("G: reconciliação na criação de automação (resposta perdida)", async ({ page }) => {
    await login(page);
    const key = `${prefix}-G`;
    const ruleName = `${prefix} G`;
    const r1 = await postRule(page, key, ruleName);
    expect(r1.status()).toBe(201);
    const id1 = (await r1.json()).data.id;
    const r2 = await postRule(page, key, ruleName);
    const replay = await r2.json();
    expect(replay.data.id).toBe(id1);
    // resposta completa: contrato normal da API preservado
    expect(replay.data.name).toBe(ruleName);
    expect(Array.isArray(replay.data.actions)).toBe(true);
    expect(replay.data.actions).toHaveLength(1);
    expect(replay.data.is_active).toBe(false);
    expect((await db.query("select is_active from automation_rules where id=$1", [id1])).rows[0].is_active).toBe(false);
    expect(await countRules(ruleName)).toBe(1);
  });
});
