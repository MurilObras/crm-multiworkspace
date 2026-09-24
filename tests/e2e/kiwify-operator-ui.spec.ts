import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Jornada da UI operacional Kiwify (PR #12): cadastrar/consultar/copiar a
 * integração e criar a automação de compra que nasce PAUSADA.
 *
 * Mesma precondição e rig do `kiwify-history.spec.ts`: exige PostgreSQL e
 * Supabase Auth LOCAIS; semear por `pg` direto; nada de produção/credencial
 * real. Não dispara workers nem provedores de mensagem.
 */
const dbUrl = process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
function local(value: string | undefined) {
  if (!value) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
}
const app = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const prefix = `E2E-KIWIFY-OP-${randomUUID().slice(0, 8)}`;
let db: pg.Pool;
let creds: { org_id: string; org_slug: string; supabase_url: string; password: string; users: Record<string, { email: string }> };
let pipeline: string, stage: string, product: string, session: string;

test.describe("Kiwify: interface operacional", () => {
  test.setTimeout(180000);
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test.beforeAll(async () => {
    if (!local(dbUrl) || !local(supabaseUrl)) {
      throw new Error("Prepare PostgreSQL e Supabase Auth locais para o E2E Kiwify");
    }
    creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8"));
    if (creds.org_slug !== "e2e-test-org" || !local(creds.supabase_url)) {
      throw new Error("Credenciais sintéticas do rig local obrigatórias");
    }
    db = new pg.Pool({ connectionString: dbUrl });
    // A cifra e executada pelo Postgres, nao pelo processo Next. O banco fresco
    // nao tem chave: semeia a fonte privada da migration 0041 somente no rig
    // local ja validado acima. Nunca rotaciona uma chave que outra spec usou.
    await db.query(`insert into private.app_secrets(name, value)
      values ('nuvemshop_oauth_key', $1) on conflict (name) do nothing`,
    [randomBytes(32).toString("hex")]);
    const cipherProbe = await db.query(`select
      public.fn_decrypt_oauth(public.fn_encrypt_oauth($1)) = $1 as ok`,
    ["kiwify-e2e-cipher-probe"]);
    expect(cipherProbe.rows[0]?.ok).toBe(true);
    const org = creds.org_id;
    pipeline = (await db.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,$2,$3,2000) returning id", [org, prefix, prefix.toLowerCase()])).rows[0].id;
    stage = (await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Synthetic','synthetic-op',2000) returning id", [org, pipeline])).rows[0].id;
    product = (await db.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,$2,'Produto OP',100) returning id", [org, prefix])).rows[0].id;
    // WORKING de propósito: a automação só oferece canal conectado no seletor.
    session = (await db.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'WORKING',$3) returning id", [org, prefix, Buffer.from("synthetic-unused")])).rows[0].id;
    mkdirSync(".superpowers/evidence/kiwify-operator-ui", { recursive: true });
  });

  test.afterAll(async () => {
    if (!db) return;
    try {
      await db.query("delete from kiwify_product_mappings where integration_id in (select id from kiwify_integrations where store_id=$1)", [prefix]);
      await db.query("delete from kiwify_integrations where store_id=$1", [prefix]);
      await db.query("delete from automation_rules where name=$1", [`Compra Kiwify ${prefix}`]);
      await db.query("delete from channel_sessions where id=$1", [session]);
      await db.query("delete from catalog_products where id=$1", [product]);
      await db.query("delete from crm_stages where id=$1", [stage]);
      await db.query("delete from crm_pipelines where id=$1", [pipeline]);
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

  test("manager cadastra, consulta e copia a integração; segredo não reaparece", async ({ page }) => {
    await login(page);
    await page.goto(`${app}/app/webhooks`);
    await page.getByRole("tab", { name: "Kiwify", exact: true }).click();
    const integracao = page.getByRole("region", { name: "Integração Kiwify" });

    await integracao.getByRole("button", { name: "Nova integração" }).click();
    await integracao.getByLabel("Nome").fill(prefix);
    await integracao.getByLabel("Store ID").fill(prefix);
    await integracao.getByLabel("Secret / token da Kiwify").fill("segredo-sintetico-nao-reusar");

    await integracao.getByRole("combobox", { name: "Funil" }).click();
    await page.getByRole("option", { name: prefix }).click();
    await integracao.getByRole("combobox", { name: "Etapa" }).click();
    await page.getByRole("option", { name: "Synthetic" }).click();
    await integracao.getByPlaceholder("external_product_id").fill("op-product");
    await integracao.getByRole("combobox", { name: "Produto interno" }).click();
    await page.getByRole("option", { name: "Produto OP" }).click();

    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/integrations/kiwify" &&
      response.request().method() === "POST");
    await integracao.getByRole("button", { name: "Salvar integração" }).click();
    expect((await saved).status(), "O cadastro precisa persistir antes de mostrar a URL").toBe(201);

    // Depois de salvar, a URL aparece no banner "Integração criada" E no item
    // recém-criado da lista — ambos refletem a mesma integração. O banner é o
    // feedback imediato do cadastro: mira nele para não depender da ambiguidade.
    const urlInput = integracao.getByLabel("URL do webhook").first();
    await expect(urlInput).toBeVisible({ timeout: 15_000 });
    await expect(urlInput).toHaveValue(/\/api\/v1\/webhooks\/kiwify\/[a-f0-9]{64}/);

    await integracao.getByRole("button", { name: "Copiar URL do webhook" }).first().click();
    await expect(page.getByText("URL copiada.")).toBeVisible({ timeout: 15_000 });

    // Segredo nunca reaparece na tela (nem em estado, nem em lista).
    await expect(page.getByText("segredo-sintetico-nao-reusar")).toHaveCount(0);

    // Consulta persistida após recarregar.
    await page.reload();
    await page.getByRole("tab", { name: "Kiwify", exact: true }).click();
    await expect(page.getByText(`Loja: ${prefix}`)).toBeVisible();
  });

  test("manager cria automação de compra que nasce pausada", async ({ page }) => {
    await login(page);
    await page.goto(`${app}/app/webhooks`);
    await page.getByRole("tab", { name: "Kiwify", exact: true }).click();
    const automacao = page.getByRole("region", { name: "Automação de compra Kiwify" });

    await automacao.getByRole("button", { name: "Criar automação de compra" }).click();
    await page.getByLabel("Nome da automação").fill(`Compra Kiwify ${prefix}`);
    await page.getByRole("combobox", { name: "Produto" }).click();
    await page.getByRole("option", { name: "Produto OP" }).click();
    await page.getByRole("combobox", { name: "Número de WhatsApp" }).click();
    await page.getByRole("option").first().click();
    await page.getByRole("textbox", { name: "Texto da mensagem" }).fill("Obrigado pela compra!");

    await page.getByRole("button", { name: "Criar automação" }).click();

    // Nasce pausada, e o estado é visível (não "Ativa").
    await expect(automacao.getByText("Pausada")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Gerenciar automação" })).toBeVisible();

    // Ativação é explícita, e só então reflete "Ativa". O texto é escopado à
    // automação: a integração Kiwify nasce ativa (is_active default true) e
    // também exibe "Ativa" — o seletor global resolveria para dois elementos.
    await page.getByRole("switch", { name: `Ligar Compra Kiwify ${prefix}` }).click();
    await expect(automacao.getByText("Ativa")).toBeVisible({ timeout: 15_000 });
  });
});
