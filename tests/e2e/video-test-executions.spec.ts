import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "@playwright/test";
import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";
import type { Database } from "@/lib/database.types";

// Banco descartável e canal parado: nenhuma mensagem sai para WhatsApp.
test.describe.configure({ mode: "serial", timeout: 180_000 });
test.use({ locale: "pt-BR" });
const idNames = [
  "agent",
  "version",
  "session",
  "contact",
  "conversation",
  "job",
  "original",
  "echo",
  "testRun",
  "testCall",
] as const;
const id = Object.fromEntries(idNames.map((k) => [k, randomUUID()])) as Record<
  (typeof idNames)[number],
  string
>;
let db: SupabaseClient;
let creds: CredsE2E & { org_id: string; users: Record<string, { id: string; email: string }> };
let mediaPath: string;
const evidence = path.join(process.cwd(), ".superpowers/evidence/video-test-executions");
async function insert<T extends keyof Database["public"]["Tables"]>(
  table: T,
  value: Database["public"]["Tables"][T]["Insert"],
) {
  const { error } = await db.from(table).insert(value);
  if (error) throw new Error(`Fixture ${table}: ${error.message}`);
}
test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))
    throw new Error("Somente Supabase local é permitido.");
  creds = lerCreds() as typeof creds;
  db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  mkdirSync(evidence, { recursive: true });
  const org = creds.org_id;
  await insert("channel_sessions", {
    id: id.session,
    organization_id: org,
    waha_session_name: `e2e-video-${id.session}`,
    webhook_secret_encrypted: "e2e",
    status: "STOPPED",
    provider: "waha",
  });
  await insert("contacts", {
    id: id.contact,
    organization_id: org,
    name: `E2E Vídeo ${id.contact}`,
    phone_number: `+55119${parseInt(id.contact!.slice(0, 8), 16).toString().padStart(8, "0").slice(-8)}`,
  });
  await insert("conversations", {
    id: id.conversation,
    organization_id: org,
    contact_id: id.contact,
    channel_session_id: id.session,
    status: "claimed",
    assigned_to_user_id: creds.users.admin!.id,
    bot_silenced_until: "infinity",
    last_message_at: new Date().toISOString(),
  });
  await insert("job_queue", {
    id: id.job,
    organization_id: org,
    contact_id: id.contact,
    kind: "inbound_turn",
    status: "failed",
    payload: { conversation_id: id.conversation },
  });
  const buffer = execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:d=0.2",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ]);
  mediaPath = `${org}/e2e-video-${id.original}.mp4`;
  const { error: uploadError } = await db.storage
    .from("whatsapp-media")
    .upload(mediaPath, buffer, { contentType: "video/mp4" });
  if (uploadError) throw uploadError;
  const before = new Date(Date.now() - 40_000).toISOString(),
    now = new Date().toISOString();
  const common = {
    organization_id: org,
    conversation_id: id.conversation,
    contact_id: id.contact,
    channel_session_id: id.session,
    type: "video",
    direction: "outbound",
    media_storage_path: mediaPath,
    media_mime: "video/mp4",
    media_size_bytes: buffer.length,
  };
  await insert("messages", {
    ...common,
    id: id.original,
    status: "failed",
    sent_via: "ai",
    error_code: "outbound_delivery_uncertain",
    metadata: { outbound_attempt: { phase: "uncertain" } },
    created_at: before,
    sent_at: before,
  });
  await insert("messages", {
    ...common,
    id: id.echo,
    status: "read",
    sent_via: "external_device",
    external_id: `true_e2e_${id.echo}`,
    ack: 3,
    metadata: { fromMe: true },
    created_at: now,
    sent_at: now,
    read_at: now,
  });
  await insert("send_ledger", {
    id: id.original,
    organization_id: org,
    contact_id: id.contact,
    job_id: id.job,
    seq: 1,
    body_hash: "0".repeat(64),
    status: "failed",
    crm_message_id: id.original,
    last_error: "outbound_delivery_uncertain",
  });
  await insert("ai_agents", {
    id: id.agent,
    organization_id: org,
    name: `E2E Execuções ${id.agent}`,
    system_prompt: "Você é um assistente de vendas de teste.",
    kind: "mcp_agent",
    is_active: false,
  });
  await insert("ai_agent_versions", {
    id: id.version,
    organization_id: org,
    agent_id: id.agent,
    version_number: 1,
    system_prompt: "Você é um assistente de vendas de teste.",
    provider: "openai",
    model: "gpt-5.6-luna",
    channel_session_id: id.session,
    status: "draft",
  });
  await insert("ai_agent_runs", {
    id: id.testRun,
    organization_id: org,
    agent_id: id.agent,
    agent_version_id: id.version,
    status: "failed",
    is_dry_run: true,
    error_code: "agent_test_result_persist_failed",
    error_message: "Falha de gravação de ensaio E2E",
    cost_cents: null,
  });
  await insert("llm_calls", {
    id: id.testCall,
    organization_id: org,
    agent_id: id.agent,
    purpose: "agent_test",
    provider: "openai",
    model: "gpt-5.6-luna",
    status: "ok",
    input_tokens: 30,
    output_tokens: 5,
    cost_cents: null,
  });
});
test.afterAll(async () => {
  if (!db || !creds?.org_id) return;
  for (const [table, key] of [
    ["llm_calls", "testCall"],
    ["ai_agent_runs", "testRun"],
    ["ai_agent_versions", "version"],
    ["ai_agents", "agent"],
    ["send_ledger", "original"],
    ["job_queue", "job"],
    ["messages", "original"],
    ["messages", "echo"],
    ["conversations", "conversation"],
    ["contacts", "contact"],
    ["channel_sessions", "session"],
  ] as const) {
    const { error } = await db
      .from(table!)
      .delete()
      .eq("organization_id", creds.org_id)
      .eq("id", id[key!]);
    if (error) throw new Error(`Limpeza ${table}: ${error.message}`);
  }
  if (mediaPath) await db.storage.from("whatsapp-media").remove([mediaPath]);
});
test.beforeEach(async ({ page }) => {
  creds = (await loginComoAdmin(page, creds)) as typeof creds;
});

test("gerente confere a prévia e reconcilia vídeo recebido sem outro envio", async ({ page }) => {
  await page.goto(`/app/inbox?id=${id.conversation}`);
  await page.getByRole("button", { name: "Confirmar vídeo recebido", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("video").first()).toBeVisible();
  await dialog.getByRole("radio").check();
  await expect(
    dialog.getByRole("button", { name: "Confirmar entrega", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await page.screenshot({ path: path.join(evidence, "video-confirmacao.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Confirmar entrega", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar vídeo recebido", exact: true }),
  ).toHaveCount(0);
  const { data, error } = await db
    .from("messages")
    .select("id,status,external_id,metadata")
    .eq("organization_id", creds.org_id)
    .eq("conversation_id", id.conversation);
  expect(error).toBeNull();
  expect(data).toHaveLength(2);
  expect(data!.find((m) => m.id === id.original)).toMatchObject({
    status: "read",
    external_id: `true_e2e_${id.echo}`,
  });
  await page.reload();
  await expect(page.locator("video")).toHaveCount(1);
  await page.screenshot({ path: path.join(evidence, "video-reconciliado.png"), fullPage: true });
});
test("execuções mostram falha de teste com tipo teste, mesmo com chamada ao modelo OK", async ({
  page,
}) => {
  await page.goto(`/app/ai/agents/${id.agent}`);
  await page.getByRole("tab", { name: /execuções/i }).click();
  const row = page.getByRole("row").filter({ hasText: "failed" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("teste");
  await expect(page.getByRole("cell", { name: "produção", exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(evidence, "execucao-teste.png"), fullPage: true });
});
test("erro na tela de teste permanece visível e não vira resultado vazio", async ({ page }) => {
  // Falha de rede controlada para provar UX; o runtime e NULL são medidos nos testes de API/banco.
  await page.route(`**/api/v1/ai/agents/${id.agent}/versions/*/test`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "agent_test_result_persist_failed",
          message: "O agente executou, mas não foi possível salvar o resultado.",
        },
      }),
    }),
  );
  await page.goto(`/app/ai/agents/${id.agent}`);
  await page.getByRole("tab", { name: "Teste", exact: true }).click();
  await page.getByLabel("Mensagem do cliente (sample)").fill("Qual é o plano para três pessoas?");
  await page.getByRole("button", { name: "Executar teste", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("não foi possível salvar o resultado");
  await expect(page.getByText("Nenhum teste executado ainda.", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(evidence, "teste-erro-visivel.png"), fullPage: true });
});
