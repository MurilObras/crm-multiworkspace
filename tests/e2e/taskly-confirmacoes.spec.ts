import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

interface Creds {
  password: string;
  zona_de_perigo: { org_a_id: string; org_a_nome: string; usuario_email: string };
}

const evidence = path.join(process.cwd(), ".superpowers/evidence/taskly-confirmacoes");

async function chooseTheme(page: Page, theme: "light" | "dark") {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Menu do usuário", exact: true }).click();
    const item = page.getByRole("menuitem", { name: /^Tema / });
    if ((await item.innerText()).trim() === (theme === "light" ? "Tema claro" : "Tema escuro")) {
      await item.press("Escape");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      return;
    }
    await item.click();
  }
  throw new Error("Não foi possível selecionar o tema pela interface.");
}

test("a confirmação destrutiva mantém vermelho e contraste, sem executar a exclusão", async ({ page }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("A captura exige o Supabase local de teste.");
  }
  // Usa as duas organizações sintéticas já mantidas pelo seed da suíte.
  // O teste só abre e cancela o diálogo; nunca aciona a exclusão.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-zona-de-perigo.ts"], { stdio: "pipe" });
  const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as Creds;
  const fixture = creds.zona_de_perigo;
  fs.mkdirSync(evidence, { recursive: true });
  await page.goto("/login");
  await page.locator("#email").fill(fixture.usuario_email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  await page.getByTestId("tenant-switcher").click();
  await page.getByTestId(`tenant-switcher-item-${fixture.org_a_id}`).click();
  await expect(page.getByTestId("tenant-switcher")).toBeEnabled({ timeout: 60_000 });
  await page.goto("/app/settings/tenant");
  await expect(page.getByTestId("zona-de-perigo")).toBeVisible();

  const measurements: unknown[] = [];
  let destructiveRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"] &&
      new URL(request.url()).pathname === "/app/settings/tenant") destructiveRequests++;
  });
  for (const theme of ["light", "dark"] as const) {
    await chooseTheme(page, theme);
    const primary = page.getByRole("button", { name: "Salvar", exact: true });
    await page.mouse.move(0, 0);
    await expect(primary).toBeEnabled();
    await expect(primary).toHaveCSS("background-image", /linear-gradient/);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("abrir-zona-de-perigo").click();
      const action = page.getByTestId("apagar-de-vez");
      await expect(action).toBeDisabled();
      await page.getByTestId("confirmar-nome-da-organizacao").fill(fixture.org_a_nome);
      await expect(action).toBeEnabled();
      for (const state of ["repouso", "hover"] as const) {
        if (state === "hover") await action.hover();
        else await page.mouse.move(0, 0);
        await expect(action).toHaveCSS("background-image", "none");
        // A transição de fundo termina antes da leitura/captura.
        await expect.poll(async () => action.evaluate((el) =>
          el.getAnimations().filter((animation) => animation.playState === "running").length,
        )).toBe(0);
        const paint = await action.evaluate((el) => {
          const style = getComputedStyle(el);
          const dialog = el.closest('[role="alertdialog"]')!;
          const surface = getComputedStyle(dialog).backgroundColor;
          const rgb = (value: string) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            const pixels = [...context.getImageData(0, 0, 1, 1).data];
            return [pixels[0]!, pixels[1]!, pixels[2]!, pixels[3]! / 255];
          };
          const raw = rgb(style.backgroundColor);
          const alpha = raw[3] ?? 1;
          const under = rgb(surface);
          const background = raw.slice(0, 3).map((c, i) => c * alpha + under[i]! * (1 - alpha));
          const foreground = rgb(style.color).slice(0, 3);
          const luminance = (color: number[]) => color.map((c) => {
            const s = c / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
          const values = [luminance(background), luminance(foreground)];
          return { foreground: style.color, background: style.backgroundColor, channels: raw,
            surface, gradient: style.backgroundImage,
            contrast: (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05) };
        });
        expect(paint.contrast, `${theme}, ${width}px, ${state}`).toBeGreaterThanOrEqual(4.5);
        const rgb = paint.channels;
        expect(rgb[0]).toBeGreaterThan(rgb[1]!);
        expect(rgb[0]).toBeGreaterThan(rgb[2]!);
        await page.screenshot({
          path: path.join(evidence, `destrutivo-${theme}-${width}-${state}.png`),
          fullPage: false, animations: "disabled",
        });
        measurements.push({ theme, width, state, ...paint });
      }
      await page.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeHidden();
    }
  }
  expect(destructiveRequests, "Abrir, conferir e cancelar não pode chamar a exclusão").toBe(0);
  fs.writeFileSync(path.join(evidence, "medidas.json"), JSON.stringify(measurements, null, 2));
});
