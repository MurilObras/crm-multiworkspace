// Componente e CSS reais, API simulada. Sem Next server, .env ou transporte.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

if (!process.env.CAMPAIGNS_TEST_TEMP) throw new Error("Set CAMPAIGNS_TEST_TEMP to a disposable local directory.");
const evidence = mkdtempSync(join(process.env.CAMPAIGNS_TEST_TEMP, "campaigns-ui-"));
let server, browser;
before(async () => {
  server = await createServer({
    configFile: false, envDir: false,
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "next/link", "@radix-ui/react-slot", "class-variance-authority", "clsx", "tailwind-merge", "zod"] },
    resolve: { alias: { "@": resolve(".") } },
    server: { host: "127.0.0.1", port: 5179, strictPort: true },
    plugins: [{
      name: "campaigns-isolated-test",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>globalThis.process={env:{NODE_ENV:"development"}};</script><script type="module" src="/@id/virtual:campaigns-fixture"></script></body></html>');
        });
      },
      resolveId(id) { if (id === "virtual:campaigns-fixture") return id; },
      load(id) {
        if (id === "virtual:campaigns-fixture") return `
          import { createElement } from 'react';
          import { createRoot } from 'react-dom/client';
          import { CampaignsClient } from '/app/app/campaigns/client.tsx';
          import '/app/globals.css';
          createRoot(document.getElementById('root')).render(createElement(CampaignsClient, {canSend: true}));
        `;
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.CAMPAIGNS_BROWSER_CHANNEL });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const [name, width, height] of [["desktop", 1280, 800], ["mobile", 390, 844]]) {
  test(`${name}: list, preview, send-now and detail fit viewport without browser errors`, async (t) => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = [];
    const posts = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const campaign = { id: "a0000000-0000-4000-8000-000000000001", name: "VIP campaign", steps: [{ message: "Hello {{literal}}", delay_minutes: 0 }], status: "running", hourly_limit: 10 };
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (url.pathname === "/api/v1/campaigns/preview") return route.fulfill({ json: { data: {
        total: 3, valid: 2, unique: 1, duplicates: 1, invalid: 1,
        contacts: [{ phone_number: "+5511987654321", name: "Maria" }],
      } } });
      if (url.pathname !== "/api/v1/campaigns") return route.continue();
      let data;
      if (request.method() === "POST") { posts.push(request.postDataJSON()); data = { id: campaign.id }; }
      else if (url.searchParams.has("preview")) data = { count: 2 };
      else if (url.searchParams.has("id")) data = { campaign, counts: { pending: 1, sent: 1, failed: 0, skipped_opt_out: 0, stopped_reply: 0 }, recipients: [], has_more: false };
      else data = { campaigns: [], channels: [{ id: "a0000000-0000-4000-8000-000000000002", phone_number: "Test WhatsApp" }] };
      await route.fulfill({ json: { data } });
    });
    try {
      await page.goto("http://127.0.0.1:5179");
      await page.getByText("Nenhuma campanha criada.").waitFor();
      await page.getByRole("button", { name: "Nova campanha" }).click();
      await page.getByLabel("Nome", { exact: true }).fill("VIP campaign");
      await page.getByLabel("Canal WhatsApp").selectOption({ label: "Test WhatsApp" });
      await page.getByLabel("Mensagem").fill("Hello {{literal}}");
      await page.getByLabel("Tag", { exact: true }).fill("vip");
      await page.getByLabel("Origem (opcional)").fill("manual");
      assert.equal(await page.getByRole("button", { name: "Enviar agora" }).isDisabled(), true);
      await page.getByRole("button", { name: "Calcular publico" }).click();
      await page.getByText("2 contatos no recorte").waitFor();
      const formOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(formOverflow, false);
      await page.screenshot({ path: join(evidence, `${name}-form.png`), fullPage: true });
      await page.getByRole("button", { name: "Enviar agora" }).click();
      for (const label of ["Pendentes", "Enviados", "Falhas", "Opt-out"]) await page.getByText(label, { exact: true }).waitFor();
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].steps, [{ message: "Hello {{literal}}", delay_minutes: 0 }]);
      assert.deepEqual(posts[0].filters, { tag: "vip", source: "manual" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(evidence, `${name}-detail.png`), fullPage: true });
      for (const mode of ["paste", "csv", "xlsx"]) {
        await page.getByRole("button", { name: "Voltar para lista" }).click();
        await page.getByRole("button", { name: "Nova campanha" }).click();
        await page.getByLabel("Nome", { exact: true }).fill(`Scheduled ${mode}`);
        await page.getByLabel("Canal WhatsApp").selectOption({ label: "Test WhatsApp" });
        await page.getByLabel("Mensagem").fill("Scheduled first");
        await page.getByRole("button", { name: "+ Adicionar mensagem" }).click();
        await page.getByLabel("Mensagem").nth(1).fill("Second");
        await page.getByLabel("Delay", { exact: true }).fill("2");
        await page.getByLabel("Publico").selectOption(mode === "paste" ? "paste" : "file");
        if (mode === "paste") await page.getByRole("textbox", { name: /^Numeros/ }).fill("11987654321;11987654321;bad");
        else await page.getByLabel("Planilha", { exact: false }).setInputFiles({ name: `audience.${mode}`, mimeType: "application/octet-stream", buffer: Buffer.from("fixture") });
        await page.getByLabel("Quando enviar").selectOption("scheduled");
        await page.getByLabel("Data e hora").fill("2030-01-01T09:30");
        await page.getByRole("button", { name: "Calcular publico" }).click();
        await page.getByText(/Total: 3/).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: join(evidence, `${name}-${mode}-schedule.png`), fullPage: true });
        await page.getByRole("button", { name: "Agendar campanha" }).click();
        await page.getByText("Pendentes", { exact: true }).waitFor();
        const posted = posts.at(-1);
        assert.equal(posted.scheduled_at, "2030-01-01T12:30:00.000Z");
        assert.deepEqual(posted.audience, [{ phone_number: "+5511987654321", name: "Maria" }]);
        assert.deepEqual(posted.steps, [{ message: "Scheduled first", delay_minutes: 0 }, { message: "Second", delay_minutes: 120 }]);
        assert.equal(posted.filters, undefined);
      }
      assert.deepEqual(errors, []);
      t.diagnostic(`Screenshots: ${evidence}`);
    } finally {
      if (errors.length) t.diagnostic(JSON.stringify(errors));
      await context.close();
    }
  });
}
