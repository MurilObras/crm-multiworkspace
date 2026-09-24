import { test, expect, type Page, type Browser, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { criarTransporteSintetico, type TransporteSintetico } from "./helpers/transporte-sintetico";

/**
 * Prova de idempotência de escrita sobre o ambiente REAL do E2E (Supabase:
 * PostgREST + GoTrue + Postgres), atravessando a ROTA real
 * (`POST /api/v1/messages`, `POST /api/v1/automation-rules`), a AUTENTICAÇÃO
 * real (login) e o HANDLER real. Só o transporte externo (WhatsApp/WAHA) é
 * substituído: um servidor sintético conta as chamadas de envio e pode perder a
 * confirmação. O que se prova é a GARANTIA DO CRM: uma chave → um recurso → um
 * transporte, mesmo sob concorrência, conflito de payload, retry e limpeza.
 */
const dbUrl = process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const wahaBase = process.env.WAHA_API_BASE_URL;
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
let transporte: TransporteSintetico;
const novosUsuarios: string[] = [];
let outraOrg: string | null = null;
let outraSessao: string | null = null;
let outroContato: string | null = null;
let outraConversa: string | null = null;
const senhaNova = "IdemE2e!2026#Local";

test.describe("Kiwify: idempotência de escrita (rotas reais)", () => {
  test.setTimeout(180000);

  test.beforeAll(async () => {
    if (!local(dbUrl) || !local(supabaseUrl)) throw new Error("Prepare PostgreSQL e Supabase Auth locais para o E2E");
    if (!wahaBase || !local(wahaBase)) throw new Error("WAHA_API_BASE_URL local é o transporte sintético da prova");
    creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8"));
    if (creds.org_slug !== "e2e-test-org" || !local(creds.supabase_url)) throw new Error("Credenciais sintéticas do rig local obrigatórias");
    db = new pg.Pool({ connectionString: dbUrl });
    const org = creds.org_id;
    managerId = (await db.query("select id from auth.users where email=$1", [creds.users.manager!.email])).rows[0].id;
    session = (await db.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit) values($1,$2,'WORKING',$3,300) returning id", [org, prefix, Buffer.from("synthetic-unused")])).rows[0].id;
    const contact = (await db.query("insert into contacts(organization_id,name,phone_number) values($1,'Idem sintético','+12025550199') returning id", [org])).rows[0].id;
    conversation = (await db.query("insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at) values($1,$2,$3,'open',now()) returning id", [org, contact, session])).rows[0].id;

    transporte = criarTransporteSintetico(wahaBase);
    await transporte.start();
  });

  test.afterAll(async () => {
    if (transporte) await transporte.stop();
    if (!db) return;
    try {
      await db.query("delete from idempotency_keys where key like $1", [`%:${prefix}%`]);
      await db.query("delete from automation_rules where name like $1", [`${prefix}%`]);
      await db.query("delete from messages where conversation_id=$1", [conversation]);
      await db.query("delete from conversations where id=$1", [conversation]);
      await db.query("delete from contacts where organization_id=$1 and phone_number='+12025550199'", [creds.org_id]);
      await db.query("delete from channel_sessions where id=$1", [session]);
      if (outraOrg) await db.query("delete from organizations where id=$1", [outraOrg]);
    } finally {
      if (novosUsuarios.length) {
        await db.query("delete from user_organizations where user_id=any($1::uuid[])", [novosUsuarios]);
      }
      await db.end();
      if (novosUsuarios.length) {
        const svc = createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
        for (const id of novosUsuarios) {
          const { error } = await svc.auth.admin.deleteUser(id);
          if (error) throw error;
        }
      }
    }
  });

  async function login(page: Page): Promise<void> {
    await page.goto(`${app}/login`);
    await page.locator("#email").fill(creds.users.manager!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/app\//);
  }

  async function novaSessao(browser: Browser, email: string, senha: string) {
    const contexto = await browser.newContext();
    const page = await contexto.newPage();
    await page.goto(`${app}/login`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/app\//);
    return { page, contexto };
  }

  async function criarUsuario(org: string) {
    const svc = createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const email = `${prefix}-${randomUUID()}@example.invalid`;
    const { data, error } = await svc.auth.admin.createUser({ email, password: senhaNova, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("Usuário sintético não criado");
    novosUsuarios.push(data.user.id);
    await db.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [data.user.id, org]);
    return { id: data.user.id, email };
  }

  async function prepararOutraOrg() {
    outraOrg = (await db.query("insert into organizations(slug,legal_name,display_name,onboarded_at) values($1,'Outra organização E2E','Outra organização E2E',now()) returning id", [`${prefix.toLowerCase()}-b`])).rows[0].id;
    outraSessao = (await db.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'WORKING',$3) returning id", [outraOrg, `${prefix}-b`, Buffer.from("synthetic-unused")])).rows[0].id;
    outroContato = (await db.query("insert into contacts(organization_id,name,phone_number) values($1,'Outro cliente','+12025550299') returning id", [outraOrg])).rows[0].id;
    outraConversa = (await db.query("insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at) values($1,$2,$3,'open',now()) returning id", [outraOrg, outroContato, outraSessao])).rows[0].id;
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

  test("A: requisições simultâneas mesma chave/payload → uma mensagem, um transporte", async ({ page }) => {
    await login(page);
    transporte.reset();
    transporte.setMode("ok");
    const mkey = `${prefix}-A-m`;
    const responses = await Promise.all(Array.from({ length: 8 }, () => postMessage(page, mkey, "Oi concorrencia")));
    expect(responses.every((r) => r.ok())).toBe(true);
    expect(await countMessages(mkey)).toBe(1);
    // Um único recurso E um único despacho ao transporte.
    expect(transporte.received.length).toBe(1);
    expect(transporte.received[0]!.text).toBe("Oi concorrencia");

    const rkey = `${prefix}-A-r`;
    const ruleName = `${prefix} A`;
    const rr = await Promise.all(Array.from({ length: 8 }, () => postRule(page, rkey, ruleName)));
    expect(rr.every((r) => r.ok())).toBe(true);
    expect(await countRules(ruleName)).toBe(1);
    expect((await db.query("select is_active from automation_rules where name=$1", [ruleName])).rows[0].is_active).toBe(false);
  });

  test("B: mesma chave com payload diferente → 409, sem novo efeito nem transporte", async ({ page }) => {
    await login(page);
    transporte.reset();
    transporte.setMode("ok");
    const key = `${prefix}-B`;
    const r1 = await postMessage(page, key, "payload um");
    expect(r1.status()).toBe(201);
    const r2 = await postMessage(page, key, "payload dois");
    expect(r2.status()).toBe(409);
    expect(await countMessages(key)).toBe(1);
    expect(transporte.received.length).toBe(1);
  });

  test("C: retry com a mesma chave recupera o mesmo recurso, sem re-transportar", async ({ page }) => {
    await login(page);
    transporte.reset();
    transporte.setMode("ok");
    const key = `${prefix}-C`;
    const r1 = await postMessage(page, key, "Oi resposta perdida");
    const id1 = (await r1.json()).data.id;
    expect(r1.status()).toBe(201);
    const r2 = await postMessage(page, key, "Oi resposta perdida");
    expect(r2.ok()).toBe(true);
    expect((await r2.json()).data.id).toBe(id1);
    expect(await countMessages(key)).toBe(1);
    expect(transporte.received.length).toBe(1);
  });

  test("D: transporte aceito sem confirmação → retries não re-transportam", async ({ page }) => {
    await login(page);
    transporte.reset();
    transporte.setMode("timeout");
    const key = `${prefix}-D`;
    const r1 = await postMessage(page, key, "Oi incerto");
    expect(r1.status()).toBe(201);
    const id1 = (await r1.json()).data.id;
    expect(id1).toBeTruthy();
    // O transporte RECEBEU a chamada (e perdeu a confirmação).
    expect(transporte.received.length).toBe(1);
    // A reconciliação volta ao modo ok, mas NÃO re-transporta.
    transporte.setMode("ok");
    for (let i = 0; i < 5; i++) {
      const r = await postMessage(page, key, "Oi incerto");
      expect((await r.json()).data.id).toBe(id1);
    }
    expect(transporte.received.length).toBe(1);
    expect(await countMessages(key)).toBe(1);
  });

  test("E: limpeza preserva conflito e o payload original ainda recupera", async ({ page }) => {
    await login(page);
    transporte.reset();
    transporte.setMode("ok");
    const key = `${prefix}-E`;
    const chave = `${managerId}:${key}`;
    const endpoint = "/api/v1/messages";
    const r1 = await postMessage(page, key, "payload original");
    const original = await r1.json();
    const id1 = original.data.id;
    expect(r1.status()).toBe(201);
    expect((await db.query("select count(*)::int n from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [creds.org_id, endpoint, chave])).rows[0].n).toBe(1);
    await db.query("delete from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [creds.org_id, endpoint, chave]);
    expect((await db.query("select count(*)::int n from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [creds.org_id, endpoint, chave])).rows[0].n).toBe(0);
    // payload DIFERENTE → 409 (hash durável no recurso), sem novo recurso
    const r2 = await postMessage(page, key, "payload diferente");
    expect(r2.status()).toBe(409);
    expect(await countMessages(key)).toBe(1);
    // payload ORIGINAL → recupera a MESMA mensagem, sem re-transportar
    const r3 = await postMessage(page, key, "payload original");
    const replay = await r3.json();
    expect(replay.data.id).toBe(id1);
    expect(replay.data.status).toBeTruthy();
    expect(await countMessages(key)).toBe(1);
    expect(transporte.received.length).toBe(1);
  });

  test("F: nova operação deliberada com outra chave → segundo recurso e segundo transporte", async ({ page }) => {
    await login(page);
    transporte.reset();
    transporte.setMode("ok");
    const a = await postMessage(page, `${prefix}-F-a`, "mesmo texto");
    const b = await postMessage(page, `${prefix}-F-b`, "mesmo texto");
    expect((await a.json()).data.id).not.toBe((await b.json()).data.id);
    expect(transporte.received.length).toBe(2);
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
    expect(replay.data.name).toBe(ruleName);
    expect(Array.isArray(replay.data.actions)).toBe(true);
    expect(replay.data.actions).toHaveLength(1);
    expect(replay.data.is_active).toBe(false);
    expect((await db.query("select is_active from automation_rules where id=$1", [id1])).rows[0].is_active).toBe(false);
    expect(await countRules(ruleName)).toBe(1);
  });

  test("H: mesma chave, usuários e organizações autenticados distintos — ambas as rotas isoladas", async ({ browser }) => {
    await prepararOutraOrg();
    const segundo = await criarUsuario(creds.org_id);
    const terceiro = await criarUsuario(outraOrg!);
    const sessoes = await Promise.all([
      novaSessao(browser, creds.users.manager!.email, creds.password),
      novaSessao(browser, segundo.email, senhaNova),
      novaSessao(browser, terceiro.email, senhaNova),
    ]);
    try {
      transporte.reset(); transporte.setMode("ok");
      const key = `${prefix}-H`;
      const contextos = [
        { page: sessoes[0]!.page, org: creds.org_id, conv: conversation, sessao: session },
        { page: sessoes[1]!.page, org: creds.org_id, conv: conversation, sessao: session },
        { page: sessoes[2]!.page, org: outraOrg!, conv: outraConversa!, sessao: outraSessao! },
      ];
      const idsMensagens: string[] = [], idsRegras: string[] = [];
      for (const [i, ctx] of contextos.entries()) {
        const body = `isolamento ${key} ${i}`;
        const payload = { conversation_id: ctx.conv, type: "text", body };
        const send = () => ctx.page.request.post(`${app}/api/v1/messages`, { headers: { "Idempotency-Key": key }, data: payload });
        const first = await send(); expect(first.status()).toBe(201);
        const id = (await first.json()).data.id as string;
        const replay = await send(); expect(replay.status()).toBe(201);
        expect((await replay.json()).data.id).toBe(id);
        expect((await db.query("select count(*)::int n from messages where id=$1 and organization_id=$2 and body=$3", [id, ctx.org, body])).rows[0].n).toBe(1);
        expect(transporte.received.filter((r) => r.text === body)).toHaveLength(1);
        idsMensagens.push(id);

        const rule = { name: `${prefix} H ${i}`, trigger_event: "lead.created", conditions: [],
          actions: [{ type: "send_whatsapp_message", config: { channel_session_id: ctx.sessao, template: "Oi" } }] };
        const create = () => ctx.page.request.post(`${app}/api/v1/automation-rules`, { headers: { "Idempotency-Key": key }, data: rule });
        const created = await create(); expect(created.status()).toBe(201);
        const ruleId = (await created.json()).data.id as string;
        const replayRule = await create(); expect(replayRule.status()).toBe(201);
        expect((await replayRule.json()).data.id).toBe(ruleId);
        expect((await db.query("select count(*)::int n from automation_rules where id=$1 and organization_id=$2 and name=$3 and is_active=false", [ruleId, ctx.org, rule.name])).rows[0].n).toBe(1);
        idsRegras.push(ruleId);
      }
      expect(new Set(idsMensagens).size).toBe(3);
      expect(new Set(idsRegras).size).toBe(3);
      expect(transporte.received.length).toBe(3);
      const alheio = sessoes[2]!.page;
      const deniedMessage = await alheio.request.post(`${app}/api/v1/messages`, {
        headers: { "Idempotency-Key": `${key}-alheio` },
        data: { conversation_id: conversation, type: "text", body: `${key}-negado` },
      });
      expect(deniedMessage.status()).toBe(404);
      expect((await deniedMessage.text())).not.toContain(idsMensagens[0]!);
      const deniedRule = await alheio.request.patch(`${app}/api/v1/automation-rules/${idsRegras[0]}`, { data: { is_active: true } });
      expect(deniedRule.status()).toBe(404);
      expect((await deniedRule.text())).not.toContain(idsRegras[0]!);
      expect(transporte.received).toHaveLength(3);
      for (const [i, id] of idsMensagens.entries()) expect((await db.query("select count(*)::int n from messages where id=$1 and organization_id=$2", [id, contextos[i]!.org])).rows[0].n).toBe(1);
      for (const [i, id] of idsRegras.entries()) expect((await db.query("select count(*)::int n from automation_rules where id=$1 and organization_id=$2 and is_active=false", [id, contextos[i]!.org])).rows[0].n).toBe(1);
    } finally { for (const s of sessoes) await s.contexto.close(); }
  });

  test("I: revogar o papel após a gravação nega replay nas duas rotas, sem novos efeitos", async ({ browser }) => {
    const usuario = await criarUsuario(creds.org_id);
    const { page, contexto } = await novaSessao(browser, usuario.email, senhaNova);
    try {
      transporte.reset(); transporte.setMode("ok");
      const key = `${prefix}-I`;
      const mensagem = () => page.request.post(`${app}/api/v1/messages`, { headers: { "Idempotency-Key": key }, data: { conversation_id: conversation, type: "text", body: `${prefix} revogação` } });
      const rule = { name: `${prefix} I`, trigger_event: "lead.created", conditions: [], actions: [{ type: "send_whatsapp_message", config: { channel_session_id: session, template: "Oi" } }] };
      const regra = () => page.request.post(`${app}/api/v1/automation-rules`, { headers: { "Idempotency-Key": key }, data: rule });
      const firstM = await mensagem(), firstR = await regra();
      expect(firstM.status()).toBe(201); expect(firstR.status()).toBe(201);
      const messageId = (await firstM.json()).data.id, ruleId = (await firstR.json()).data.id;
      expect(transporte.received).toHaveLength(1);
      await db.query("update user_organizations set role='viewer' where user_id=$1 and organization_id=$2", [usuario.id, creds.org_id]);
      try {
        for (const response of [await mensagem(), await regra()]) {
          expect(response.status()).toBe(403);
          const text = await response.text();
          expect(text).not.toContain(messageId); expect(text).not.toContain(ruleId);
        }
        expect((await db.query("select count(*)::int n from messages where id=$1 and organization_id=$2", [messageId, creds.org_id])).rows[0].n).toBe(1);
        expect((await db.query("select count(*)::int n from automation_rules where id=$1 and organization_id=$2 and is_active=false", [ruleId, creds.org_id])).rows[0].n).toBe(1);
        expect(transporte.received).toHaveLength(1);
      } finally {
        await db.query("update user_organizations set role='manager' where user_id=$1 and organization_id=$2", [usuario.id, creds.org_id]);
      }
    } finally { await contexto.close(); }
  });

  test("J: formulário Kiwify perde a resposta HTTP do CRM após gravar, depois reconcilia", async ({ page }) => {
    const org = creds.org_id, order = `${prefix}-J`;
    const pipeline = (await db.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,$2,$3,3000) returning id", [org, order, order.toLowerCase()])).rows[0].id as string;
    try {
      const stage = (await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'E2E','e2e',3000) returning id", [org, pipeline])).rows[0].id as string;
      const product = (await db.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,$2,'Produto E2E',100) returning id", [org, order])).rows[0].id as string;
      const integration = (await db.query("insert into kiwify_integrations(organization_id,store_id,name,path_token,secret_encrypted,pipeline_id,stage_id) values($1,$2,$2,$3,$4,$5,$6) returning id", [org, order, randomBytes(32).toString("hex"), Buffer.from("synthetic-unused"), pipeline, stage])).rows[0].id as string;
      const contact = (await db.query("select contact_id from conversations where id=$1", [conversation])).rows[0].contact_id as string;
      const lead = (await db.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,source,position_in_stage,custom_fields) values($1,$2,$3,$4,$5,'webhook',3000,$6) returning id", [org, pipeline, stage, contact, order, { product_id: product }])).rows[0].id as string;
      await db.query("insert into kiwify_receipts(organization_id,integration_id,order_id,event_type,fingerprint,status,external_id,lead_id) values($1,$2,$3,'order_approved',$4,'accepted',$5,$6)", [org, integration, order, "a".repeat(64), order, lead]);
      await login(page);
      await page.goto(`${app}/app/webhooks`);
      await page.getByRole("tab", { name: "Kiwify", exact: true }).click();
      const historico = page.getByRole("region", { name: "Acompanhamento Kiwify" });
      await historico.getByLabel("Compra, nome ou telefone").fill(order);
      await expect(historico.getByRole("heading", { name: `Compra ${order}` })).toBeVisible();
      await historico.getByRole("button", { name: "Enviar mensagem" }).click();
      const dialog = page.getByRole("dialog", { name: "Enviar mensagem" });
      await dialog.getByRole("combobox", { name: "Número de WhatsApp" }).click();
      await page.getByRole("option", { name: prefix }).click();
      await dialog.getByRole("textbox", { name: "Texto da mensagem" }).fill(order);

      transporte.reset(); transporte.setMode("ok");
      const tentativas: Array<{ key: string | null; body: unknown }> = [];
      page.on("request", (req) => {
        if (new URL(req.url()).pathname === "/api/v1/messages" && req.method() === "POST")
          tentativas.push({ key: req.headers()["idempotency-key"] ?? null, body: req.postDataJSON() });
      });
      let persistedId = "";
      let recebeu!: () => void;
      let falhou!: (err: unknown) => void;
      const perdida = new Promise<void>((resolve, reject) => { recebeu = resolve; falhou = reject; });
      const perderResposta = async (route: Route) => {
        try {
          const real = await route.fetch();
          expect(real.status()).toBe(201);
          persistedId = (await real.json()).data.id as string;
          expect((await db.query("select count(*)::int n from messages where id=$1 and organization_id=$2 and body=$3", [persistedId, org, order])).rows[0].n).toBe(1);
          expect(transporte.received.filter((r) => r.text === order)).toHaveLength(1);
          await route.abort("failed"); // depois do 201 real; nunca entrega a resposta ao apiClient
          recebeu();
        } catch (err) { falhou(err); await route.abort("failed").catch(() => {}); }
      };
      await page.route("**/api/v1/messages", perderResposta);
      await dialog.getByRole("button", { name: "Confirmar envio" }).click();
      await perdida;
      await page.unroute("**/api/v1/messages", perderResposta);
      await expect(dialog).toBeVisible();
      const replay = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/messages" && r.request().method() === "POST");
      await dialog.getByRole("button", { name: /Confirmar envio|Reconciliar/ }).click();
      const response = await replay;
      expect(response.status()).toBe(201);
      expect((await response.json()).data.id).toBe(persistedId);
      expect(tentativas).toHaveLength(2);
      expect(tentativas[0]!.key).toBeTruthy();
      expect(tentativas[1]).toEqual(tentativas[0]);
      expect((await db.query("select count(*)::int n from messages where id=$1 and organization_id=$2", [persistedId, org])).rows[0].n).toBe(1);
      expect(transporte.received.filter((r) => r.text === order)).toHaveLength(1);
    } finally {
      await db.query("delete from kiwify_receipts where order_id=$1 and organization_id=$2", [order, org]);
      await db.query("delete from kiwify_integrations where store_id=$1 and organization_id=$2", [order, org]);
      await db.query("delete from crm_leads where title=$1 and organization_id=$2", [order, org]);
      await db.query("delete from catalog_products where codigo=$1 and organization_id=$2", [order, org]);
      await db.query("delete from crm_stages where pipeline_id=$1", [pipeline]);
      await db.query("delete from crm_pipelines where id=$1", [pipeline]);
    }
  });
});
