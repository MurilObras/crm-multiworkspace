/**
 * Prova em tela da integração opcional Google Calendar BYO.
 *
 * O perfil padrão não configura Google: verifica que a Agenda interna abre e
 * explica o recurso opcional sem esconder a grade nem culpar o usuário.
 *
 * O perfil E2E_GOOGLE_LIVE=1 exige aplicativo OAuth e conta Google dedicados.
 * A pessoa autoriza em navegador visível; o teste verifica o consentimento, a
 * troca real do código, a conexão persistida na tela e a desconexão de limpeza.
 * Não há callback simulado nem conexão semeada nesse perfil. Sem autorização
 * externa, esse caso permanece explicitamente pendente e não prova aprovação.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const ESPERA = 60_000;
const GOOGLE_REAL = process.env.E2E_GOOGLE_LIVE === "1";
test.describe.configure({ mode: "serial", timeout: 180_000 });
// O consentimento real pode mostrar senha, código e tokens. Sem trace/vídeo.
if (GOOGLE_REAL) test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("conectar a agenda do Google", () => {
  let page: Page;
  let limparConexaoReal = false;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    page = await browser.newPage();
    await loginComoAdmin(page, lerCreds());
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.afterEach(async () => {
    if (!limparConexaoReal) return;
    limparConexaoReal = false;
    // Hook com orçamento próprio: o timeout do consentimento não pode impedir
    // a limpeza. O teste exige começar sem conexão e só usa o app local.
    await page.goto("/app/agenda");
    if (await page.getByTestId("desconectar-google").isVisible()) {
      const removida = page.waitForResponse(r => r.url().endsWith("/api/v1/agenda/google/desconectar") && r.request().method() === "DELETE");
      await page.getByTestId("desconectar-google").click();
      expect((await removida).ok(), "a conexão de teste deve ser removida ao terminar").toBe(true);
      await expect(page.getByTestId("google-conectado")).toHaveCount(0);
    }
  });

  test("sem chave do Google, a Agenda abre e explica o que falta", async () => {
    test.skip(GOOGLE_REAL, "o perfil de consentimento real exige Google configurado; o perfil sem chave roda separadamente");
    await page.goto("/app/agenda");

    // 1. A TELA ABRE INTEIRA. Env opcional ausente degrada com explicação, não
    //    derruba o módulo — é o que `configuracaoDoGoogle()` devolvendo `null`
    //    existe para permitir.
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
    // `exact` porque o nome casa por SUBSTRING: com a agenda vazia, o aviso
    // "Sua agenda está livre esta semana" é um segundo heading, e os dois
    // coexistem desde que o vazio deixou de esconder a grade. Sem `exact`, dois
    // elementos → strict mode → vermelho. A spec irmã já tinha pago isto.
    await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();

    // 2. O BOTÃO NÃO APARECE — e não é "aparece desabilitado". Desabilitado
    //    diria "você não pode"; o certo é "esta instalação ainda não tem".
    await expect(page.getByTestId("conectar-google")).toHaveCount(0);

    // 3. E NO LUGAR DELE há explicação, com três propriedades que importam:
    const explicacao = page.getByTestId("google-nao-configurado");
    await expect(explicacao).toBeVisible();
    //    (a) não culpa quem está lendo
    await expect(explicacao).toContainText(/não é nada que você tenha feito/i);
    //    (b) diz QUEM resolve
    await expect(explicacao).toContainText(/quem instalou/i);
    //    (c) diz o que continua funcionando — senão a pessoa acha que a agenda quebrou
    await expect(explicacao).toContainText(/funciona normalmente/i);

    // 4. E o texto NÃO despeja código: nada de nome de variável com underscore
    //    no meio da frase para quem não programa. A exceção é o bloco `o-que-falta`,
    //    que é deliberadamente o nome técnico da chave — quem instalou precisa dele.
    const corpo = await explicacao.innerText();
    const semOBloco = corpo.replace((await page.getByTestId("o-que-falta").innerText().catch(() => "")) || "\u0000", "");
    expect(semOBloco, `código cru na frase: ${semOBloco}`).not.toMatch(/[a-z]+_[a-z]+_[a-z]+/);
  });

  test("conectar a agenda do Google pela tela e ver a faixa mudar", async ({ baseURL }) => {
    test.setTimeout(300_000);
    // Opt-in com conta dedicada e --headed: a pessoa autoriza no Google,
    // e o teste verifica o retorno real. O perfil padrão continua sem Google.
    if (!GOOGLE_REAL && process.env.E2E_REQUIRE_EXTERNALS === "1") {
      throw new Error("O consentimento Google real exige E2E_GOOGLE_LIVE=1 e uma conta dedicada de teste.");
    }
    test.skip(!GOOGLE_REAL, "consentimento real requer perfil E2E_GOOGLE_LIVE e autorização da conta Google de teste");
    const origem = new URL(baseURL!);
    if (origem.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origem.hostname)) {
      throw new Error("A conexão Google E2E só pode ser criada no aplicativo local de testes.");
    }
    const emailEsperado = process.env.E2E_GOOGLE_EXPECTED_EMAIL?.trim();
    if (!emailEsperado) throw new Error("Informe E2E_GOOGLE_EXPECTED_EMAIL para não validar outra conta por engano.");

    await page.goto("/app/agenda");
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: ESPERA });
    await expect(page.getByTestId("google-conectado"), "o teste precisa começar sem uma conexão anterior").toHaveCount(0);
    await expect(page.getByTestId("conectar-google")).toBeVisible();
    limparConexaoReal = true;
    const ida = page.waitForResponse(r => r.url().endsWith("/api/v1/agenda/google/connect") && r.request().method() === "GET");
    await page.getByTestId("conectar-google").click();
    const inicio = await ida;
    expect(inicio.status()).toBe(307);
    const consentimento = new URL(inicio.headers().location!);
    expect(consentimento.origin).toBe("https://accounts.google.com");
    await page.waitForURL("https://accounts.google.com/**", { timeout: ESPERA });
    expect(consentimento.searchParams.get("access_type")).toBe("offline");
    expect(consentimento.searchParams.get("prompt")).toBe("consent");
    expect(consentimento.searchParams.get("redirect_uri")).toBe(`${origem.origin}/api/v1/agenda/google/callback`);
    expect(Boolean(consentimento.searchParams.get("state"))).toBe(true);
    console.info("[E2E Google] Autorize a conta dedicada na janela do navegador; não informe senha ou código no chat.");

    // A interação externa é real e pode exigir MFA. Não simular o callback nem
    // semear uma conexão: isto precisa provar a troca e a gravação do token.
    await page.waitForURL(url => url.origin === origem.origin && url.pathname === "/app/agenda", { timeout: 180_000 });
    expect(new URL(page.url()).searchParams.has("erro"), "a autorização retornou um erro à Agenda").toBe(false);
    const conectado = page.getByTestId("google-conectado");
    await expect(conectado).toBeVisible({ timeout: ESPERA });
    await expect(conectado).toContainText(emailEsperado);
    await page.reload();
    await expect(page.getByTestId("tela-agenda")).toBeVisible();
    await expect(conectado).toContainText(emailEsperado);
    const evidencias = process.env.E2E_GOOGLE_EVIDENCE_DIR ?? path.join(process.cwd(), ".superpowers/evidence/google-real");
    fs.mkdirSync(evidencias, { recursive: true });
    await page.screenshot({ path: path.join(evidencias, "conexao-confirmada.png"), fullPage: true });
  });
});
