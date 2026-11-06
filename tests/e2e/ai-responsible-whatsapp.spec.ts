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

const fixtures: Record<string, unknown>[]=[];
test.beforeEach(()=>{ fixtures.length=0; });
test.afterEach(()=>{
  if(fixtures.length) expect(driver("cleanup",{org:fixtures[0]!.org,fixtures}).cleaned).toBe(true);
});

test("configura pelas telas e entrega texto e áudio, sem repetição ou reenvio incerto", async ({ page }) => {
  test.setTimeout(300_000);
  await loginComoAdmin(page,lerCreds());
  const creds = JSON.parse(readFileSync(".e2e-creds.json", "utf8"));
  const fixture = driver("init", { org: creds.org_id });
  fixtures.push(fixture);
  await page.goto(`/app/ai/agents/${fixture.agent}`);
  const panel = page.getByTestId("responsible-consultation");
  await expect(panel.getByRole("switch", { name: "Ativar consulta e avisos aos responsáveis" })).not.toBeChecked();
  const name = `Responsável sintético ${String(fixture.agent).slice(0, 8)}`;
  await panel.getByLabel("Nome do responsável", { exact: true }).fill(name);
  await panel.getByLabel("WhatsApp com código do país").fill(`+55119${String(Date.now()).slice(-8)}`);
  await panel.getByRole("button", { name: "Salvar responsável", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Responsável salvo");
  await panel.getByRole("checkbox", { name: new RegExp(name) }).check();
  await panel.getByLabel("Situações que exigem confirmação").fill("Condições comerciais fora da base aprovada.");
  await panel.getByRole("switch", { name: "Ativar consulta e avisos aos responsáveis" }).check();
  await panel.getByRole("button", { name: "Salvar consulta ao responsável", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("salva e conferida");
  await page.reload();
  await expect(panel.getByRole("switch", { name: "Ativar consulta e avisos aos responsáveis" })).toBeChecked();
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
  fixtures.push(failureFixture);
  await page.goto(`/app/ai/agents/${failureFixture.agent}`);
  await panel.getByRole("checkbox",{name:new RegExp(name)}).check();
  await panel.getByRole("switch", { name: "Ativar consulta e avisos aos responsáveis" }).check();
  await panel.getByRole("button",{name:"Salvar consulta ao responsável",exact:true}).click();
  await expect(panel.getByRole("status")).toContainText("salva e conferida");
  const third = driver("open", failureFixture); driver("drive", { ...failureFixture, ...third });
  const failed = driver("answer", { ...failureFixture, ...third, text: "Resposta sintética com falha de transporte.", fail_transport: true });
  expect(failed.request_status).toBe("answered"); expect(failed.automatic_paused).toBe(true);
  expect(failed.deliveries).toContainEqual({ purpose: "answer", status: "uncertain" });
  expect(driver("drive", { ...failureFixture, ...third }).captures).toEqual([]);
});


test("consulta silenciosa, encerramento interno e retry de áudio sem responder mensagem antiga",async({page})=>{
 test.setTimeout(180_000);
 await loginComoAdmin(page,lerCreds());
 const creds=JSON.parse(readFileSync(".e2e-creds.json","utf8"));
 const fixture=driver("init",{org:creds.org_id});fixtures.push(fixture);
 await page.goto(`/app/ai/agents/${fixture.agent}`);
 const panel=page.getByTestId("responsible-consultation");
 const name=`Responsável sintético ${String(fixture.agent).slice(0,8)}`;
 await panel.getByLabel("Nome do responsável",{exact:true}).fill(name);
 await panel.getByLabel("WhatsApp com código do país").fill(`+55119${String(Date.now()).slice(-8)}`);
 await panel.getByRole("button",{name:"Salvar responsável",exact:true}).click();
 await expect(panel.getByRole("status")).toContainText("Responsável salvo");
 await panel.getByRole("checkbox",{name:new RegExp(name)}).check();
 await panel.getByRole("switch",{name:"Ativar consulta e avisos aos responsáveis"}).check();
 await panel.getByRole("switch",{name:"Avisar o cliente enquanto consulta o responsável"}).uncheck();
 await panel.getByRole("switch",{name:"Consultar responsável quando um áudio não puder ser processado"}).check();
 await panel.getByRole("button",{name:"Salvar consulta ao responsável",exact:true}).click();
 await expect(panel.getByRole("status")).toContainText("salva e conferida");
 await page.reload();
 await expect(panel.getByRole("switch",{name:"Avisar o cliente enquanto consulta o responsável"})).not.toBeChecked();
 await expect(panel.getByRole("switch",{name:"Consultar responsável quando um áudio não puder ser processado"})).toBeChecked();
 const opened=driver("open",fixture);
 const drive=driver("drive",{...fixture,...opened});
 expect(drive.automatic_paused).toBe(true);
 expect((drive.captures as {body?:string}[]).some(c=>c.body?.includes("Vou confirmar essa informação"))).toBe(false);
 await page.goto(`/app/ai/cases`);
 await page.getByText("Condição comercial para confirmar",{exact:true}).first().click();
 await page.getByRole("radio",{name:/Encerrar sem enviar mensagem/}).click();
 await page.getByLabel("Motivo do encerramento interno").fill("Já tratado pela equipe, sem nova mensagem.");
 await page.getByRole("button",{name:"Encerrar sem enviar",exact:true}).click();
 await expect(page.getByText("Caso encerrado sem enviar mensagem ao cliente.",{exact:true})).toBeVisible();
 const closed=driver("status",fixture);
 expect(closed.automatic_paused).toBe(false);expect(closed.reply_jobs).toBe(0);
 const media=driver("media",fixture);
 await page.goto(`/app/inbox?id=${fixture.conv}`);
 const retry=page.getByRole("button",{name:"Reprocessar mídia",exact:true});await expect(retry).toBeVisible();
 const before=driver("status",{...fixture,...media});await retry.click();
 await expect(retry).not.toBeVisible();
 const after=driver("status",{...fixture,...media});expect(after.reply_jobs).toBe(0);expect(after.derive_events).toBe(1);
 expect((after.messages as unknown[]).length).toBe((before.messages as unknown[]).length);
 const evidence=join(process.cwd(),".superpowers/evidence/school-operations");mkdirSync(evidence,{recursive:true});
 await page.screenshot({path:join(evidence,"media-reprocess-desktop.png"),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.goto(`/app/ai/agents/${fixture.agent}`);
 await expect(panel.getByRole("switch",{name:"Consultar responsável quando um áudio não puder ser processado"})).toBeChecked();
 await panel.screenshot({path:join(evidence,"consultation-mobile.png")});
});


test("histórico abre sob demanda, pagina e mantém a versão publicada para o diff",async({page})=>{
 test.setTimeout(120_000);await loginComoAdmin(page,lerCreds());
 const creds=JSON.parse(readFileSync(".e2e-creds.json","utf8"));const fixture=driver("init",{org:creds.org_id});fixtures.push(fixture);driver("history",fixture);
 let historyRequests=0;page.on("request",request=>{if(request.method()==="GET" && request.url().includes(`/api/v1/ai/agents/${fixture.agent}/versions?`))historyRequests++;});
 const response=await page.goto(`/app/ai/agents/${fixture.agent}`);const html=await response!.text();
 expect(html).not.toContain("HISTORY_ONLY_02");expect(historyRequests).toBe(0);
 await page.getByRole("tab",{name:"Histórico",exact:true}).click();
 await expect(page.getByRole("button",{name:"Carregar versões anteriores",exact:true})).toBeVisible();
 await expect(page.getByText("v31",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Carregar versões anteriores",exact:true}).click();
 await expect(page.getByText("v2",{exact:true})).toBeVisible();
 const row=page.locator("li").filter({has:page.getByText("v2",{exact:true})});await row.getByRole("button",{name:"Diff",exact:true}).click();
 const dialog=page.getByRole("dialog");
 await expect(dialog).toContainText("HISTORY_ONLY_02");
 const evidence=join(process.cwd(),".superpowers/evidence/school-operations");mkdirSync(evidence,{recursive:true});
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:844});
  const bounds=await dialog.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(width);
  await dialog.screenshot({path:join(evidence,`history-paged-${width}.png`)});
 }
});


test("etiquetas e origem dos avisos ficam acessíveis pelas telas",async({page})=>{
 test.setTimeout(120_000);await loginComoAdmin(page,lerCreds());
 const creds=JSON.parse(readFileSync(".e2e-creds.json","utf8"));const fixture=driver("init",{org:creds.org_id});fixtures.push(fixture);
 const tags=driver("tags",fixture);await page.goto(`/app/pipelines/${tags.pipeline}`);
 await page.getByRole("heading",{name:"Negócio sintético de etiquetas",exact:true}).click();
 const region=page.getByRole("region",{name:"Etiquetas por origem"});
 await expect(region.getByText("etiqueta-do-negocio",{exact:true})).toBeVisible();
 await expect(region.getByText("etiqueta-do-contato",{exact:true})).toBeVisible();
 const evidence=join(process.cwd(),".superpowers/evidence/school-operations");mkdirSync(evidence,{recursive:true});
 await region.screenshot({path:join(evidence,"tags-by-origin-desktop.png")});
 const media=driver("media",{...fixture,alert:true});await page.goto("/app/ai/inbox");
 const notice=page.getByTestId("inbox-item").filter({hasText:String(media.alert_title)});
 await expect(notice.getByRole("link",{name:"Abrir atendimento",exact:true})).toBeVisible();
 await expect(notice.getByText("Situação atual da origem: Falha")).toBeVisible();
 await expect(notice.locator("time")).toHaveAttribute("datetime",/\d{4}-\d{2}-\d{2}/);
 await notice.screenshot({path:join(evidence,"notice-origin-desktop.png")});
 await notice.getByRole("link",{name:"Abrir atendimento",exact:true}).click();
 await expect(page).toHaveURL(url => url.pathname === "/app/inbox" && url.searchParams.get("id") === String(fixture.conv));
 await expect(page.getByRole("button",{name:"Reprocessar mídia",exact:true})).toBeVisible();
});
