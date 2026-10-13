import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

/**
 * Responder citando: dados próprios, sem depender da ordem de outras specs.
 * Só escreve no Supabase LOCAL validado pelo runner. Não envia WhatsApp.
 * Selecionar, cancelar e trocar de conversa são feitos pela interface real.
 */
interface E2ECreds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence/responder-citando");
const channelId = randomUUID();
const runId = randomUUID().slice(0, 8);
const conversations = ["A", "B"].map((letter) => ({
  id: randomUUID(),
  contactId: randomUUID(),
  messageId: randomUUID(),
  name: `Citação ${letter} ${runId}`,
  body: `Mensagem da conversa ${letter} para citar.`,
}));

let creds: E2ECreds;
let admin: SupabaseClient | undefined;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
}

async function selectConversation(page: Page, index: number) {
  const conversation = conversations[index]!;
  const button = page.locator(`button[data-conversation-id="${conversation.id}"]`);
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "true");
  const bubble = page.locator("div.group").filter({
    has: page.getByText(conversation.body, { exact: true }),
  });
  await expect(bubble).toHaveCount(1, { timeout: 30_000 });
  await expect(bubble).toBeVisible();
  return { conversation, bubble };
}

async function quoteMessage(page: Page, index: number) {
  const { conversation, bubble } = await selectConversation(page, index);
  await bubble.hover();
  const reply = bubble.getByRole("button", { name: "Responder a esta mensagem", exact: true });
  await expect(reply).toBeVisible();
  await expect(reply).toHaveCSS("opacity", "1");
  await reply.click();
  const cancel = page.getByRole("button", { name: "Cancelar resposta", exact: true });
  await expect(cancel).toBeVisible();
  await expect(cancel.locator("..")).toContainText(conversation.body);
  return cancel;
}

test.describe("responder citando", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // Sem fallback para .env.local: uma execução manual não pode semear produção.
    if (!url || !key || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error("Este teste exige Supabase local e ambiente E2E explícito.");
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    if (!creds.org_id || !creds.users.agent?.id) throw new Error("Credenciais E2E incompletas.");
    admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    fs.mkdirSync(EVIDENCE, { recursive: true });

    const { error: channelError } = await admin.from("channel_sessions").insert({
      id: channelId,
      organization_id: creds.org_id,
      waha_session_name: `e2e-citacao-${runId}`,
      webhook_secret_encrypted: "e2e",
      status: "WORKING",
    });
    if (channelError) throw new Error(`Preparar canal de teste: ${channelError.message}`);
    for (const conversation of conversations) {
      const now = new Date().toISOString();
      const phone = `+5511${parseInt(conversation.contactId.slice(0, 8), 16).toString().padStart(10, "0")}`;
      const { error: contactError } = await admin.from("contacts").insert({
        id: conversation.contactId,
        organization_id: creds.org_id,
        display_name: conversation.name,
        phone_number: phone,
      });
      if (contactError) throw new Error(`Preparar contato de teste: ${contactError.message}`);
      const { error: conversationError } = await admin.from("conversations").insert({
        id: conversation.id,
        organization_id: creds.org_id,
        contact_id: conversation.contactId,
        channel_session_id: channelId,
        status: "claimed",
        assigned_to_user_id: creds.users.agent!.id,
        assigned_at: now,
        bot_silenced_until: "infinity",
        last_message_at: now,
        last_inbound_at: now,
        last_message_preview: conversation.body,
      });
      if (conversationError)
        throw new Error(`Preparar conversa de teste: ${conversationError.message}`);
      const { error: messageError } = await admin.from("messages").insert({
        id: conversation.messageId,
        organization_id: creds.org_id,
        conversation_id: conversation.id,
        contact_id: conversation.contactId,
        channel_session_id: channelId,
        direction: "inbound",
        type: "text",
        status: "delivered",
        body: conversation.body,
        sent_at: now,
      });
      if (messageError) throw new Error(`Preparar mensagem de teste: ${messageError.message}`);
    }
  });

  test.afterAll(async () => {
    if (!admin) return;
    // Apaga somente os UUIDs criados por ESTA execução, dentro da mesma org.
    for (const [table, ids] of [
      ["conversations", conversations.map((c) => c.id)],
      ["contacts", conversations.map((c) => c.contactId)],
      ["channel_sessions", [channelId]],
    ] as const) {
      const { error } = await admin
        .from(table)
        .delete()
        .eq("organization_id", creds.org_id)
        .in("id", [...ids]);
      if (error) throw new Error(`Limpar ${table} de teste: ${error.message}`);
    }
  });

  test("o botão de responder revela a faixa, e o × a desfaz", async ({ page }) => {
    await login(page);
    await page.goto("/app/inbox?filter=mine");
    const cancel = await quoteMessage(page, 0);
    await page.screenshot({ path: path.join(EVIDENCE, "faixa.png"), fullPage: true });
    await cancel.click();
    await expect(cancel).toHaveCount(0);
    await expect(page.getByPlaceholder("Escreva uma mensagem…")).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, "cancelada.png"), fullPage: true });
  });

  test("trocar de conversa LIMPA a citação", async ({ page }) => {
    await login(page);
    await page.goto("/app/inbox?filter=mine");
    const cancel = await quoteMessage(page, 0);
    const documentMarker = randomUUID();
    await page.evaluate((marker) => {
      document.documentElement.dataset.quoteDocument = marker;
    }, documentMarker);
    const urlBeforeSwitch = page.url();

    // Clique real na B, sem page.goto/reload: o estado da A precisa ser limpo
    // pelo mesmo caminho que o atendente usa, não pelo descarte da página.
    await selectConversation(page, 1);
    await expect(page.locator("html")).toHaveAttribute("data-quote-document", documentMarker);
    expect(page.url()).toBe(urlBeforeSwitch);
    await expect(cancel).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCE, "troca.png"), fullPage: true });

    const cancelInB = await quoteMessage(page, 1);
    await expect(cancelInB.locator("..")).not.toContainText(conversations[0]!.body);
    await cancelInB.click();
    await expect(cancelInB).toHaveCount(0);
  });
});
