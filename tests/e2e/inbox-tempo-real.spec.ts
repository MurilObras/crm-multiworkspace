/** Inbox real: prova a entrega pelo WebSocket com um assinante anônimo paralelo.
 * O frame recebido discrimina entrega de refetch/foco. Anônimo não recebe
 * dados nem pode interromper a avaliação RLS do membro autenticado.
 * Banco, Auth, Realtime, cookies httpOnly e navegador são reais e isolados.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  /** Bloco gravado por `seed-e2e-queue.ts` — a conversa que este teste usa. */
  queue?: { conversation_id: string; contact_name: string };
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

/**
 * SEMEIA SEMPRE, nunca "só se o arquivo não existir".
 *
 * `.e2e-creds.json` é estado de disco: ele sobrevive a um banco recriado e passa
 * a apontar para uma organização que não existe mais. Medido — o seed da fila
 * morria com `channel_sessions_organization_id_fkey`, e a causa não era o teste
 * nem o banco, era um arquivo velho. Os seeds são idempotentes; pular por
 * existência de arquivo troca um custo pequeno por uma falha confusa.
 */
function creds(): E2ECreds {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], {
    stdio: "inherit",
  });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

/**
 * A CONVERSA QUE ESTE TESTE PRECISA — semeada, nunca pressuposta.
 *
 * O seed de credenciais NÃO cria conversas. Depender de "já ter alguma no banco"
 * passaria na máquina de quem desenvolve (onde o banco acumulou histórico) e
 * falharia num banco fresco, que é o do CI — e é o único que vale como prova.
 * `seed-e2e-queue.ts` já monta o trio contato + canal + conversa e é idempotente.
 */
function semearConversa(): NonNullable<E2ECreds["queue"]> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], {
    stdio: "inherit",
  });
  const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
  if (!c.queue) throw new Error("bloco `queue` ausente em .e2e-creds.json após o seed");
  return c.queue;
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * Faz a mensagem CHEGAR — fora do browser, como o webhook do WhatsApp chega.
 *
 * Se a mensagem fosse escrita pela própria página, o teste provaria que a UI
 * mostra o que ela mesma escreveu, que é outra coisa. O script grava as duas
 * pontas que o inbox escuta (`messages` e o carimbo de `conversations`) — dois
 * canais no mesmo socket, e era a coexistência deles que expunha o defeito.
 */
function chegarMensagem(conversationId: string, corpo: string): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/e2e-chega-mensagem.ts", conversationId, corpo],
    { cwd: process.cwd(), stdio: "inherit" },
  );
}

test.describe("inbox em tempo real", () => {
  /**
   * O TETO DE 30s DO `playwright.config.ts` NÃO CABE NESTE TESTE.
   *
   * Medido no CI: `Test timeout of 30000ms exceeded` na última asserção — o
   * teste chegou até o fim e o relógio o matou. As esperas somam ~67s no pior
   * caso (cabeçalho 20s + assentar 2s + canal de pé 20s + a mensagem 25s), e
   * cada uma delas existe por uma razão: são os prazos de uma tela que fala com
   * um socket, não folga preguiçosa.
   *
   * Subir o teto do describe é o padrão do repo para specs assim
   * (`agente-novo-e-uso`, `capacidades-do-agente`, `distribuicao-atendimento`…),
   * e o fim de `docs/testing/user-journey-map.md` avisa exatamente isto para
   * quem escreve spec nova. Eu li e não apliquei — daí a segunda rodada vermelha.
   */
  test.describe.configure({ timeout: 120_000 });

  /**
   * Os seeds saem de DENTRO do relógio do teste.
   *
   * São dois `execFileSync` (credenciais + fila) que sobem processos Node e
   * falam com o banco. Rodando dentro do `test()`, eles gastavam o orçamento do
   * teste antes de o browser abrir a primeira página. `beforeAll` tem relógio
   * próprio — o tempo de preparar deixa de competir com o tempo de medir.
   */
  let c: E2ECreds;
  let fila: NonNullable<E2ECreds["queue"]>;

  test.beforeAll(() => {
    c = creds();
    fila = semearConversa();
  });

  test("mensagem chega por WebSocket sem F5, mesmo com inscrição anônima", async ({ page }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Somente QA local.');
    const anonymous = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const conversationId = fila.conversation_id;
    const corpo = `chegou por WebSocket ${Date.now()}`;
    let joinedAsManager = false, receivedMessage = false, anonymousEvents = 0;
    page.on('websocket', ws => {
      ws.on('framesent', ({ payload }) => {
        try {
          const j = JSON.parse(String(payload));
          const event = Array.isArray(j) ? j[3] : j.event;
          const p = Array.isArray(j) ? j[4] : j.payload;
          if (event !== 'phx_join' || !p?.config?.postgres_changes?.some((x: {table?:string;filter?:string}) =>
            x.table === 'messages' && x.filter === `conversation_id=eq.${conversationId}`)) return;
          const claims = JSON.parse(Buffer.from(String(p.access_token).split('.')[1]!, 'base64url').toString());
          joinedAsManager ||= claims.role === 'authenticated' && claims.sub === c.users.manager!.id;
        } catch { /* frame de outro tipo; nenhum token vai para log */ }
      });
      ws.on('framereceived', ({ payload }) => {
        try {
          const j = JSON.parse(String(payload));
          const event = Array.isArray(j) ? j[3] : j.event;
          const p = Array.isArray(j) ? j[4] : j.payload;
          receivedMessage ||= event === 'postgres_changes' && p?.data?.table === 'messages'
            && p.data.record?.conversation_id === conversationId && p.data.record?.body === corpo;
        } catch { /* frame não JSON */ }
      });
    });
    try {
      await login(page, c.users.manager!.email, c.password);
      await page.goto(`/app/inbox?id=${conversationId}&filter=all`);
      await expect(page.getByRole('heading',{level:2,name:fila.contact_name})).toBeVisible({timeout:20_000});
      await expect.poll(()=>joinedAsManager,{timeout:20_000}).toBe(true);
      const thread=page.getByTestId('chat-thread');
      await expect(thread).toHaveAttribute('data-realtime-status-mensagens','subscribed',{timeout:20_000});
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Assinatura anônima não iniciou.')),15_000);
        anonymous.channel(`anon-regression-${Date.now()}`).on('postgres_changes',{
          event:'INSERT',schema:'public',table:'messages',filter:`conversation_id=eq.${conversationId}`,
        },()=>anonymousEvents++).subscribe(status=>{
          if(status==='SUBSCRIBED'){clearTimeout(timer);resolve();}
          else if(status==='CHANNEL_ERROR'){clearTimeout(timer);reject(new Error('Canal anônimo recusado.'));}
        });
      });
      chegarMensagem(conversationId,corpo);
      // Uma leitura HTTP/foco não satisfaz esta asserção. Sem evento real o
      // teste falha, mesmo que a rede de segurança atualize a bolha depois.
      await expect.poll(()=>receivedMessage,{timeout:10_000}).toBe(true);
      await expect(thread.getByText(corpo,{exact:true})).toBeVisible({timeout:10_000});
      await expect(page.locator('[data-conversation-id]').first()).toHaveAttribute('data-conversation-id',conversationId);
      expect(anonymousEvents).toBe(0);
      await expect(thread).toHaveAttribute('data-refetch-divergencias-mensagens','0');
      fs.mkdirSync('.superpowers/evidence/inbox-tempo-real',{recursive:true});
      await page.screenshot({path:'.superpowers/evidence/inbox-tempo-real/mensagem-sem-reload.png',fullPage:true});
    } finally { await anonymous.removeAllChannels(); }
  });
});