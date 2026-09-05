/**
 * E2E — CRIAR WORKSPACE, VIRAR ADMIN, TROCAR E SOBREVIVER AO REFRESH.
 *
 * ─── O que esta spec cobre, e o que ela NÃO repete ──────────────────────────
 *
 * A jornada mínima da feature "Workspace": o admin cria um workspace novo pelo
 * menu do usuário, o vínculo nasce `admin`, o workspace aparece no seletor, dá
 * para trocar de workspace, e o refresh preserva a escolha (cookie `active_org`).
 *
 * A troca de organização NÃO-configurada (que cai no onboarding e "tem volta")
 * já é da `troca-de-organizacao-tem-volta.spec.ts`, e o escopo da Agenda por
 * organização é da `agenda-escopo-da-organizacao.spec.ts` — não são repetidos
 * aqui.
 *
 * A criação deixa o workspace novo SEM `onboarded_at` (mesmo modelo do signup).
 * Para exercer o switcher (que vive no shell de `/app`), a spec marca o
 * workspace como onboarded via service role — o que se prova aqui é o switcher e
 * o cookie, não o wizard de seis passos (esse é do `wizard-do-funcionario`).
 */
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const NOME = `Workspace E2E ${randomUUID().slice(0, 6)}`;

let orgId = "";

test.afterAll(async () => {
  if (orgId) {
    await svc.from("user_organizations").delete().eq("organization_id", orgId);
    await svc.from("organizations").delete().eq("id", orgId);
  }
});

test("criar workspace vira admin, aparece no switcher, troca e sobrevive ao refresh", async ({ page }) => {
  const base = lerCreds() as ReturnType<typeof lerCreds> & { org_id?: string };
  const orgAId = base.org_id;
  expect(orgAId, "o seed não gravou org_id").toBeTruthy();

  await loginComoAdmin(page, base);

  await page.goto("/app/inbox");
  await page.waitForURL(/\/app\/inbox/, { timeout: 20_000 });

  // 1. Criar workspace pelo menu do usuário.
  await page.getByRole("button", { name: /menu do usuário/i }).click();
  await page.getByTestId("criar-workspace").click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo.getByRole("heading", { name: /criar workspace/i })).toBeVisible();
  await dialogo.getByLabel(/nome do workspace/i).fill(NOME);
  await dialogo.getByRole("button", { name: /criar workspace/i }).click();

  // O workspace novo nasce em onboarding e já é o ativo (cookie apontando para ele).
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 });

  // 2. "usuário vira admin": o vínculo criado tem papel admin.
  const { data: org } = await svc
    .from("organizations")
    .select("id")
    .eq("display_name", NOME)
    .maybeSingle();
  expect(org, "o workspace não foi criado no banco").not.toBeNull();
  orgId = (org as { id: string }).id;

  const { data: membro } = await svc
    .from("user_organizations")
    .select("role")
    .eq("organization_id", orgId)
    .maybeSingle();
  expect((membro as { role: string } | null)?.role).toBe("admin");

  // Marca onboarded só para poder voltar ao shell de /app e exercer o switcher.
  await svc.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", orgId);

  // 3. Workspace aparece no switcher.
  await page.goto("/app/inbox");
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor).toBeVisible({ timeout: 20_000 });
  await expect(seletor).toContainText(NOME, { timeout: 20_000 });

  // 4. Trocar de workspace (para a org do seed) e voltar.
  const { data: orgA } = await svc
    .from("organizations")
    .select("display_name")
    .eq("id", orgAId)
    .maybeSingle();
  const nomeA = (orgA as { display_name: string }).display_name;

  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${orgAId}`).click();
  await expect(seletor).toContainText(nomeA, { timeout: 20_000 });

  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${orgId}`).click();
  await expect(seletor).toContainText(NOME, { timeout: 20_000 });

  // 5. Refresh preserva o contexto (cookie active_org).
  await page.reload();
  await expect(page.getByTestId("tenant-switcher")).toContainText(NOME, { timeout: 20_000 });
});
