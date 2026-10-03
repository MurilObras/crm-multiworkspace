import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "node:http";
import { emailReturnResponse } from "../../lib/auth/email-return-response";

test.describe("auth flow", () => {
  test("anon GET /app/inbox redirects to /login", async ({ page }) => {
    await page.goto("/app/inbox");
    // Either we land on /login (with optional ?next=) or middleware sends us elsewhere
    await page.waitForURL(/\/login/);
    expect(page.url()).toMatch(/\/login/);
  });

  test("invalid login shows error", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill("nobody@example.com");
    await page.locator("#password").fill("wrong-password-xyz");
    await page.getByRole("button", { name: /entrar/i }).click();
    // Wait for either an inline error or that we did NOT navigate to /app
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/app\//);
  });

  test("login form is keyboard navigable in tab order", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").focus();
    await expect(page.locator("#email")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#password")).toBeFocused();
    await page.keyboard.press("Tab");
    // Next focusable is the submit button
    const submit = page.getByRole("button", { name: /entrar/i });
    await expect(submit).toBeFocused();
  });

  test("login page has no serious or critical a11y violations", async ({ page }) => {
    await page.goto("/login");
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
});

test("retorno do e-mail mantém a sessão Strict na tela seguinte", async ({ page }) => {
  const received: { callback?: string; destination?: string } = {};
  const server = createServer(async (request, response) => {
    const port = (server.address() as { port: number }).port;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/request") {
      response.setHeader("Set-Cookie", [
        "pkce=test; HttpOnly; SameSite=Lax; Path=/",
        "old-session=test; HttpOnly; SameSite=Strict; Path=/",
      ]);
      response.end("Solicitação criada");
    } else if (request.url === "/mail") {
      response.end(`<a href="http://localhost:${port}/callback">Confirmar acesso</a>`);
    } else if (request.url === "/callback") {
      received.callback = request.headers.cookie ?? "";
      const result = emailReturnResponse(new URL(`http://localhost:${port}/reset`));
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.setHeader("Set-Cookie", "session=test; HttpOnly; SameSite=Strict; Path=/");
      response.end(await result.text());
    } else if (request.url === "/reset") {
      received.destination = request.headers.cookie ?? "";
      response.end("<h1>Definir nova senha</h1>");
    } else response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await page.goto(`http://localhost:${port}/request`);
    // localhost e 127.0.0.1 são sites distintos para a política SameSite.
    await page.goto(`http://127.0.0.1:${port}/mail`);
    await page.getByRole("link", { name: "Confirmar acesso" }).click();
    await page.waitForURL("**/reset");
    await expect(page.getByRole("heading", { name: "Definir nova senha" })).toBeVisible();
    expect(received.callback).toBe("pkce=test");
    expect(received.destination).toContain("session=test");
    const session = (await page.context().cookies()).find((cookie) => cookie.name === "session");
    expect(session).toMatchObject({ sameSite: "Strict", httpOnly: true });
    await test
      .info()
      .attach("retorno-email-sessao-strict", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
