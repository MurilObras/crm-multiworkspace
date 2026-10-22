import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { loginComoAdmin, lerCreds } from "./helpers/login-admin";

function driver(mode: string, input: Record<string, unknown>): Record<string, unknown> {
  const requireFromRoot = createRequire(join(process.cwd(),"package.json"));
  const output = execFileSync(process.execPath, [requireFromRoot.resolve("tsx/cli"), "scripts/e2e-responsible-journey.ts", mode, JSON.stringify(input)],
    { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 });
  const line = output.split("\n").find(l => l.startsWith("RESULT:")); if (!line) throw new Error("Driver sem resultado.");
  return JSON.parse(line.slice(7));
}

test("configura pelas telas e entrega texto e áudio, sem repetição ou reenvio incerto", async ({ page }) => {
  test.setTimeout(300_000);
  await loginComoAdmin(page,lerCreds());
  const creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8"));
  const fixture = driver("init", { org: creds.org_id });
  await page.goto(`/app/ai/agents/${fixture.agent}`);
  const panel = page.getByTestId("responsible-consultation");
  await expect(panel.getByRole("switch")).not.toBeChecked();
  const name = `Responsável sintético ${String(fixture.agent).slice(0, 8)}`;
  await panel.getByLabel("Nome do responsável", { exact: true }).fill(name);
  await panel.getByLabel("WhatsApp com código do país").fill(`+55119${String(Date.now()).slice(-8)}`);
  await panel.getByRole("button", { name: "Salvar responsável", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Responsável salvo");
  await panel.getByRole("checkbox", { name: new RegExp(name) }).check();
  await panel.getByLabel("Situações que exigem confirmação").fill("Condições comerciais fora da base aprovada.");
  await panel.getByRole("switch").check();
  await panel.getByRole("button", { name: "Salvar consulta ao responsável", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("salva e conferida");
  await page.reload();
  await expect(panel.getByRole("switch")).toBeChecked();
  await expect(panel.getByLabel("Situações que exigem confirmação")).toHaveValue("Condições comerciais fora da base aprovada.");
  const evidence = join(process.cwd(), ".superpowers/evidence/responsible-whatsapp"); mkdirSync(evidence, { recursive: true });
  await panel.screenshot({ path: join(evidence, "01-configuracao-salva.png") });

  const first = driver("open", fixture);
  expect(driver("drive", { ...fixture, ...first }).automatic_paused).toBe(true);
  const text = "Condição confirmada.\n\nPode seguir com a contratação 🙂";
  const answer = driver("answer", { ...fixture, ...first, text });
  expect(answer.request_status).toBe("delivered"); expect(answer.automatic_paused).toBe(false);
  expect(answer.captures).toContainEqual({ type: "text", body: text });
  expect(driver("drive", { ...fixture, ...first }).captures).toEqual([]);
  await page.goto("/app/ai/cases");
  await page.getByRole("tab",{name:"Concluídos",exact:true}).click();
  await page.getByText("Condição comercial para confirmar", { exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Consulta pelo WhatsApp" })).toContainText("Entregue ao cliente");
  await page.screenshot({ path: join(evidence, "02-resposta-entregue.png"), fullPage: true });

  const second = driver("open", fixture); driver("drive", { ...fixture, ...second });
  const audio = driver("answer", { ...fixture, ...second, audio: true });
  expect(audio.request_status).toBe("delivered"); expect(audio.captures).toContainEqual({ type: "audio", sha256: audio.voice_sha256 });
  expect(driver("drive", { ...fixture, ...second }).captures).toEqual([]);

  const offline=driver("open",fixture);
  expect(driver("drive",{...fixture,...offline,disconnected:true}).captures).toEqual([]);
  const recovered=driver("drive",{...fixture,...offline,reconnect:true});
  expect(recovered.captures).not.toEqual([]);
  expect(driver("answer",{...fixture,...offline,text:"Conexão recuperada, condição confirmada."}).request_status).toBe("delivered");

  const human=driver("open",{...fixture,handoff:true}); driver("drive",{...fixture,...human});
  const humanAnswer=driver("answer",{...fixture,...human,text:"Estou acompanhando pessoalmente seu atendimento."});
  expect(humanAnswer.request_status).toBe("delivered"); expect(humanAnswer.automatic_paused).toBe(true);

  // Nova conversa/cliente para provar falha incerta sem reaproveitar o handoff humano.
  const failureFixture=driver("init",{org:creds.org_id});
  await page.goto(`/app/ai/agents/${failureFixture.agent}`);
  await panel.getByRole("checkbox",{name:new RegExp(name)}).check();
  await panel.getByRole("switch").check();
  await panel.getByRole("button",{name:"Salvar consulta ao responsável",exact:true}).click();
  await expect(panel.getByRole("status")).toContainText("salva e conferida");
  const third = driver("open", failureFixture); driver("drive", { ...failureFixture, ...third });
  const failed = driver("answer", { ...failureFixture, ...third, text: "Resposta sintética com falha de transporte.", fail_transport: true });
  expect(failed.request_status).toBe("answered"); expect(failed.automatic_paused).toBe(true);
  expect(failed.deliveries).toContainEqual({ purpose: "answer", status: "uncertain" });
  expect(driver("drive", { ...failureFixture, ...third }).captures).toEqual([]);
});
