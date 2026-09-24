import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Transporte WhatsApp sintético para a suíte E2E.
 *
 * A prova de idempotência precisa atravessar a ROTA real, a AUTENTICAÇÃO real e
 * o HANDLER real — só o transporte externo (WAHA) é substituído. O `.env.e2e`
 * já aponta `WAHA_API_BASE_URL` para um endereço local onde NADA escuta; aqui
 * subimos um servidor HTTP nesse MESMO endereço que CONTA as chamadas de envio
 * e pode simular "aceitei mas perdi a confirmação" (socket destruído sem
 * resposta). O processo sob teste (`next start`) e o processo de teste dividem
 * o 127.0.0.1, então o envio que sai do handler chega a este contador.
 */

export type ModoTransporte = "ok" | "timeout";

export interface EnvioRecebido {
  session: string;
  chatId: string;
  text: string;
}

export interface TransporteSintetico {
  /** Envios que o handler de fato despachou (na ordem). */
  received: EnvioRecebido[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  setMode: (mode: ModoTransporte) => void;
}

async function lerCorpo(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

export function criarTransporteSintetico(baseUrl: string): TransporteSintetico {
  const url = new URL(baseUrl);
  const received: EnvioRecebido[] = [];
  let mode: ModoTransporte = "ok";
  let server: Server | null = null;

  async function responder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const corpo = await lerCorpo(req);
    let payload: Record<string, unknown> = {};
    if (corpo) {
      try {
        payload = JSON.parse(corpo) as Record<string, unknown>;
      } catch {
        // corpo não-JSON: segue vazio
      }
    }

    // Envio de texto — o que o adapter WAHA despacha para mensagem comum.
    if (req.method === "POST" && req.url?.startsWith("/api/sendText")) {
      received.push({
        session: String(payload.session ?? ""),
        chatId: String(payload.chatId ?? ""),
        text: String(payload.text ?? ""),
      });
      if (mode === "timeout") {
        // O transporte RECEBEU a chamada e perdeu a confirmação (destroy).
        res.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `synthetic-${randomUUID()}` }));
      return;
    }

    // Consulta de existência do número (não é chamada para número fora do BR,
    // mas o endpoint fica pronto para o caso de o destinatário mudar).
    if (req.method === "GET" && req.url?.startsWith("/api/contacts/check-exists")) {
      const u = new URL(req.url, "http://localhost");
      const phone = u.searchParams.get("phone") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ numberExists: true, chatId: `${phone}@c.us` }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }

  async function start(): Promise<void> {
    server = createServer((req, res) => {
      void responder(req, res);
    });
    server.listen(Number(url.port), url.hostname);
    await once(server, "listening");
  }

  async function stop(): Promise<void> {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }

  return {
    received,
    start,
    stop,
    reset: () => {
      received.length = 0;
    },
    setMode: (m: ModoTransporte) => {
      mode = m;
    },
  };
}
