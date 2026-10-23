// @vitest-environment node
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST, PATCH, DELETE } from "@/app/api/v1/ai/agents/[id]/audios/route";
import { PATCH as patchAgent } from "@/app/api/v1/ai/agents/[id]/route";

const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "10000000-0000-4000-8000-000000000060";
const state = vi.hoisted(() => ({ admin: null as unknown as SupabaseClient }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: ID }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/messaging/media/prerecorded-audio", () => ({
  prerecordedAudioFormat: () => true,
  normalizePrerecordedAudio: async () => Buffer.from("OggSOpusHead-test"),
}));

let server: Server;
let row: Record<string, unknown>;
let requests: URL[];
let loseResponse: "before" | "after" | null;
let failRead: boolean;
let conflict: boolean;
let patchSeen: boolean;
let rejectWrite: boolean;
const remove = vi.fn(async () => ({ error: null }));
const ctx = { params: Promise.resolve({ id: ID }) };
const request = (method: string, body?: FormData | Record<string, unknown>) =>
  new NextRequest(`http://app/api/v1/ai/agents/${ID}/media`, {
    method,
    ...(body
      ? body instanceof FormData
        ? { body }
        : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });

// Receiver HTTP real com limite de URL baixo: o antigo filtro JSON falha aqui.
// Os invariantes de SQL/revisão são medidos separadamente contra o banco real.
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://receiver");
    requests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (Buffer.byteLength(req.url!) > 8192) {
      res.writeHead(414).end("{}");
      return;
    }
    if (!url.pathname.endsWith("/ai_agents")) {
      res.end("[]");
      return;
    }
    if (req.method === "PATCH") {
      patchSeen = true;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (rejectWrite) {
        res.writeHead(400).end(JSON.stringify({ code: "23514", message: "Rejeição sintética" }));
        return;
      }
      if (loseResponse === "before") {
        res.writeHead(502).end("{}");
        return;
      }
      if (conflict) {
        row.config_revision = Number(row.config_revision) + 1;
        conflict = false;
      }
      if (
        url.searchParams.get("config_revision") !== `eq.${row.config_revision}` &&
        url.searchParams.has("config_revision")
      ) {
        res.end("[]");
        return;
      }
      Object.assign(row, JSON.parse(raw));
      row.config_revision = Number(row.config_revision) + 1;
      if (loseResponse === "after") {
        res.writeHead(502).end("{}");
        return;
      }
    } else if (failRead && patchSeen) {
      res.writeHead(503).end("{}");
      return;
    }
    const selected = Object.fromEntries(
      (url.searchParams.get("select") ?? "")
        .split(",")
        .map((s) => s.trim())
        .map((s) => [s, row[s]]),
    );
    res.end(JSON.stringify([selected]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const client = createClient(`http://127.0.0.1:${port}`, "synthetic-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  state.admin = {
    from: client.from.bind(client),
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove,
      }),
    },
  } as unknown as SupabaseClient;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
beforeEach(() => {
  row = {
    id: ID,
    organization_id: ORG,
    kind: "mcp_agent",
    config_revision: 0,
    config: { rag_top_k: 8 },
    published_version_id: null,
  };
  requests = [];
  loseResponse = null;
  failRead = false;
  conflict = false;
  patchSeen = false;
  rejectWrite = false;
  remove.mockClear();
});
function form() {
  const f = new FormData();
  f.set("file", new File(["audio"], "test.ogg", { type: "audio/ogg" }));
  f.set("title", "Novo áudio");
  f.set("use_when", "Conteúdo de teste sem cliente real.");
  return f;
}
function largeCatalog(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const id = `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return {
      id,
      title: `Gravação ${i}`,
      use_when: "a".repeat(900),
      send_when: "b".repeat(900),
      storage_path: `${ORG}/agent-audios/${ID}/${id}.ogg`,
      mime: "audio/ogg",
      size_bytes: 200,
      enabled: true,
      required: false,
      trigger_type: "topic",
      stage_ids: [],
      allow_requested_repeat: true,
    };
  });
}
it("salva o 20º item, edita o agente, alterna e remove sem JSON na URL; 21º é recusado", async () => {
  row.config = { rag_top_k: 8, approved_media: largeCatalog(19) };
  expect(Buffer.byteLength(JSON.stringify(row.config))).toBeGreaterThan(27_000);
  expect((await POST(request("POST", form()), ctx)).status).toBe(200);
  expect((await POST(request("POST", form()), ctx)).status).toBe(422);
  const response = await patchAgent(request("PATCH", { config: { rag_top_k: 12 } }), ctx);
  expect(response.status).toBe(200);
  expect((await response.json()).data).not.toHaveProperty("config_revision");
  const config = row.config as { rag_top_k: number; approved_media: { id: string }[] };
  expect(config.rag_top_k).toBe(12);
  expect(config.approved_media).toHaveLength(20);
  const id = config.approved_media[0]!.id;
  expect((await PATCH(request("PATCH", { audio_id: id, enabled: false }), ctx)).status).toBe(200);
  expect((await PATCH(request("PATCH", { audio_id: id, enabled: true }), ctx)).status).toBe(200);
  expect((await DELETE(request("DELETE", { audio_id: id }), ctx)).status).toBe(200);
  for (const url of requests) {
    expect(url.searchParams.has("config")).toBe(false);
    expect(Buffer.byteLength(url.href)).toBeLessThan(2048);
    if (url.pathname.endsWith("/ai_agents"))
      expect(url.searchParams.get("organization_id")).toBe(`eq.${ORG}`);
  }
});
it("conflito real no transporte não sobrescreve e limpa só o upload rejeitado", async () => {
  conflict = true;
  expect((await POST(request("POST", form()), ctx)).status).toBe(409);
  expect(row.config).toEqual({ rag_top_k: 8 });
  expect(remove).toHaveBeenCalledOnce();
});
it("resposta perdida depois do commit recupera sucesso e mantém arquivo referenciado", async () => {
  loseResponse = "after";
  expect((await POST(request("POST", form()), ctx)).status).toBe(200);
  expect(remove).not.toHaveBeenCalled();
});
it("resultado desconhecido nunca remove arquivo nem afirma falha definitiva", async () => {
  loseResponse = "before";
  const response = await POST(request("POST", form()), ctx);
  expect(response.status).toBe(503);
  expect((await response.json()).error.message).toContain("confirmar");
  expect(remove).not.toHaveBeenCalled();
});

it("falha na reconciliação também preserva o upload e retorna resultado incerto", async () => {
  loseResponse = "after";
  failRead = true;
  expect((await POST(request("POST", form()), ctx)).status).toBe(503);
  expect(remove).not.toHaveBeenCalled();
});

it("rejeição SQL confirmada limpa o upload sem apresentar erro interno do banco", async () => {
  rejectWrite = true;
  const response = await POST(request("POST", form()), ctx);
  expect(response.status).toBe(500);
  expect((await response.json()).error.message).not.toContain("23514");
  expect(remove).toHaveBeenCalledOnce();
});

it("edição geral com revisão obsoleta preserva as mídias de outra operação", async () => {
  row.config = { rag_top_k: 8, approved_media: largeCatalog(1) };
  conflict = true;
  expect((await patchAgent(request("PATCH", { config: { rag_top_k: 12 } }), ctx)).status).toBe(409);
  expect((row.config as { rag_top_k: number }).rag_top_k).toBe(8);
  expect((row.config as { approved_media: unknown[] }).approved_media).toHaveLength(1);
});
