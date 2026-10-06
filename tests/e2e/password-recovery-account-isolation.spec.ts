/** Regressão: o link da conta B não pode trocar a senha da conta A já logada. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { waitForEmail, extractAuthConfirmLink, uniqueEmail } from "./helpers/auth";

const ownerEmail = uniqueEmail("recovery-owner");
const targetEmail = uniqueEmail("recovery-target");
const ownerPassword = "SenhaOwner!123";
const targetPassword = "SenhaTarget!123";
const targetNewPassword = "SenhaTargetNova!456";

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("Supabase local e credenciais sintéticas do runner obrigatórios");
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });
  const { data: target, error: targetError } = await admin.auth.admin.createUser({
    email: targetEmail,
    password: targetPassword,
    email_confirm: true,
  });
  if (ownerError || targetError || !owner.user || !target.user) {
    throw new Error(`seed users: ${ownerError?.message ?? targetError?.message}`);
  }

  const { data: org, error: orgError } = await admin.from("organizations").insert({
    slug: `e2e-recovery-isolation-${Date.now()}`,
    display_name: "Loja E2E Recovery",
    legal_name: "Loja E2E Recovery",
    status: "active",
    created_by: owner.user.id,
  }).select("id").single();
  if (orgError || !org) throw new Error(`seed org: ${orgError?.message}`);

  const { error: memberError } = await admin.from("user_organizations").insert([
    { user_id: owner.user.id, organization_id: org.id, role: "admin", accepted_at: new Date().toISOString() },
    { user_id: target.user.id, organization_id: org.id, role: "agent", accepted_at: new Date().toISOString() },
  ]);
  if (memberError) throw new Error(`seed membership: ${memberError.message}`);
});

test("recuperar conta B no navegador logado em A preserva a senha de A", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);

  await page.goto("/login");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Senha").fill(ownerPassword);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });

  await page.goto("/login/forgot");
  await page.getByLabel("Email").fill(targetEmail);
  await page.getByRole("button", { name: "Enviar link de redefinição" }).click();
  await expect(page.getByText("Verifique seu e-mail")).toBeVisible();

  const html = await waitForEmail(targetEmail, "Redefinir senha");
  await page.goto(extractAuthConfirmLink(html, baseURL!));
  await expect(page).toHaveURL(/\/login\/reset/);
  await expect(page.getByRole("button", { name: "Definir nova senha" })).toBeVisible();
  await page.getByLabel("Nova senha", { exact: true }).fill(targetNewPassword);
  await page.getByLabel("Confirmar nova senha").fill(targetNewPassword);
  await page.getByRole("button", { name: "Definir nova senha" }).click();
  await expect(page).toHaveURL(/\/login\?reset=success/);
  await expect(page.getByText("Senha redefinida com sucesso. Entre com a nova senha.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("recuperacao-conta-correta.png"), fullPage: true });

  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Senha").fill(ownerPassword);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(targetEmail);
  await page.getByLabel("Senha").fill(targetNewPassword);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });
});
