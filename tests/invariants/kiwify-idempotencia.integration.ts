import { randomUUID, createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  chaveDeIdempotencia,
  concluirIdempotencia,
  hashCanonico,
  idRecurso,
  reservarOuReplay,
} from "@/lib/api/idempotency";

/**
 * Prova REAL de idempotência de escrita: Postgres + PostgREST reais, handler
 * real (`sendMessageHandler`), camada de idempotência real e transporte
 * sintético que CONTA chamadas e pode perder a confirmação. Só o transporte é
 * substituído. Roda no harness nativo (`vitest.kiwify.config.ts`).
 */
if (process.env.KIWIFY_TEST_NATIVE !== "1" || !process.env.KIWIFY_TEST_POSTGREST) {
  throw new Error("Requires native PostgREST harness");
}

const runtime = vi.hoisted(() => ({
  db: null as unknown as pg.Pool,
  endpoint: "",
  mode: "ok" as "ok" | "timeout",
  received: [] as Array<{ to: string }>,
  send: vi.fn(async (envelope: unknown) => {
    const response = await fetch(runtime.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error("synthetic_rejected");
    return (await response.json()) as { externalId: string };
  }),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => runtime.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "id, provider, waha_session_name",
  DEFAULT_CHANNEL_PROVIDER: "waha",
  capabilitiesOf: () => ({ freeformOutsideWindow: true, requiresTemplates: false }),
  resolveSessionRef: (s: unknown) => s,
  getAdapter: () => ({
    isConfigured: () => true,
    resolveRecipient: (c: { phoneNumber: string }) => c.phoneNumber,
    echoExternalIds: undefined,
    send: (envelope: unknown) => runtime.send(envelope),
    sendTemplate: (envelope: unknown) => runtime.send(envelope),
    codes: { sendFailed: "provider_send_failed", notConfigured: "waha_not_configured", unknownError: "provider_unknown" },
  }),
}));

const pool = new pg.Pool({ host: "127.0.0.1", port: Number(process.env.TEST_DB_PORT), user: "postgres", database: "kiwify_test", max: 12 });
let rest: ChildProcess, proxy: Server, admin: SupabaseClient;
const org = randomUUID(), user = randomUUID();
let session: string, conversation: string;

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

beforeAll(async () => {
  runtime.db = pool;
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')", [org]);
  await pool.query("insert into auth.users(id,email) values($1,'idem@example.invalid')", [user]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [user, org]);
  session = (await pool.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'WORKING',$3) returning id", [org, randomUUID(), Buffer.from("synthetic-test")])).rows[0].id;
  const contact = (await pool.query("insert into contacts(organization_id,name,phone_number) values($1,'Cliente sintético','+12025550199') returning id", [org])).rows[0].id;
  conversation = (await pool.query("insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at) values($1,$2,$3,'open',now()) returning id", [org, contact, session])).rows[0].id;

  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));
  const jwtSecret = "synthetic-jwt-secret-only-for-isolated-validation";
  rest = spawn(process.env.KIWIFY_TEST_POSTGREST!, [], {
    stdio: "ignore", windowsHide: true,
    env: {
      ...process.env,
      PGRST_DB_URI: `postgresql://postgres@127.0.0.1:${process.env.TEST_DB_PORT}/kiwify_test`,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(port),
      PGRST_LOG_LEVEL: "crit",
    },
  });
  await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true), { timeout: 15000 });
  proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks);
    if (req.url?.startsWith("/provider")) {
      runtime.received.push(JSON.parse(body.toString("utf8")) as { to: string });
      if (runtime.mode === "timeout") { res.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ externalId: `synthetic-${randomUUID()}` }));
      return;
    }
    const r = await fetch(`http://127.0.0.1:${port}${req.url!.slice(8)}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body.length ? { body } : {}) });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  const gateway = await listen(proxy);
  runtime.endpoint = `http://127.0.0.1:${gateway}/provider`;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const jwt = `${header}.${claims}.${createHmac("sha256", jwtSecret).update(`${header}.${claims}`).digest("base64url")}`;
  admin = createClient(`http://127.0.0.1:${gateway}`, jwt, { auth: { persistSession: false } });
});

afterAll(async () => {
  proxy?.closeAllConnections();
  if (proxy) await new Promise<void>((r) => proxy.close(() => r()));
  if (rest && rest.exitCode === null) { rest.kill(); await once(rest, "exit"); }
  await pool.end();
});

const ENDPOINT = "/api/v1/messages";

/** Replica o fluxo idempotente da rota (pre-check → reserva → handler → concluir). */
async function enviar(key: string, body: string): Promise<{ conflito: boolean; messageId: string }> {
  const chave = chaveDeIdempotencia(user, key);
  const hash = hashCanonico({ conversation_id: conversation, type: "text", body });
  const recursoId = idRecurso(org, user, ENDPOINT, key);

  const { data: jaExiste } = await admin
    .from("messages").select("id, metadata")
    .eq("id", recursoId).eq("organization_id", org).maybeSingle();
  if (jaExiste) {
    const existingHash = (jaExiste as { metadata?: Record<string, unknown> }).metadata?.idempotency_hash;
    if (existingHash !== hash) return { conflito: true, messageId: "" };
    const m = await sendMessageHandler(admin, { organization_id: org, actor: { type: "user", id: user }, requestId: "t" },
      { conversation_id: conversation, type: "text", body, metadata: { idempotency_key: chave, idempotency_hash: hash } },
      { messageId: recursoId, returnExistingOnConflict: true });
    return { conflito: false, messageId: m.id };
  }

  const reserva = await reservarOuReplay(admin, { organizationId: org, endpoint: ENDPOINT, chave, hash, recursoId });
  if (reserva.tipo === "conflito") return { conflito: true, messageId: "" };
  const m = await sendMessageHandler(admin, { organization_id: org, actor: { type: "user", id: user }, requestId: "t" },
    { conversation_id: conversation, type: "text", body, metadata: { idempotency_key: chave, idempotency_hash: hash } },
    { messageId: recursoId, returnExistingOnConflict: true });
  await concluirIdempotencia(admin, { organizationId: org, endpoint: ENDPOINT, chave, recursoId, statusCode: 201 });
  return { conflito: false, messageId: m.id };
}

describe("idempotência de escrita — PostgREST real + transporte sintético", () => {
  it("A: 8 requisições simultâneas mesma chave → 1 mensagem e 1 transporte", async () => {
    runtime.mode = "ok"; runtime.received = []; runtime.send.mockClear();
    const key = `a-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => enviar(key, "Oi concorrencia")));
    expect(results.filter((r) => r.conflito).length).toBe(0);
    expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
    expect(runtime.received.length).toBe(1);
    expect(runtime.received[0]!.to).toBe("+12025550199");
  });

  it("B: mesma chave com payload diferente (concorrente) → um vence, outro conflito", async () => {
    runtime.mode = "ok"; runtime.received = []; runtime.send.mockClear();
    const key = `b-${randomUUID()}`;
    const [a, b] = await Promise.all([enviar(key, "payload um"), enviar(key, "payload dois")]);
    const conflitos = [a, b].filter((r) => r.conflito).length;
    expect(conflitos).toBe(1);
    expect([a, b].filter((r) => !r.conflito).length).toBe(1);
    expect(runtime.received.length).toBe(1);
  });

  it("C: resposta perdida após persistência → retry recupera o mesmo recurso", async () => {
    runtime.mode = "ok"; runtime.received = []; runtime.send.mockClear();
    const key = `c-${randomUUID()}`;
    const first = await enviar(key, "Oi resposta perdida");
    const replay = await enviar(key, "Oi resposta perdida");
    expect(replay.messageId).toBe(first.messageId);
    expect(runtime.received.length).toBe(1);
  });

  it("D: transporte aceito sem confirmação → retries mantêm a contagem em 1", async () => {
    // timeout: o transporte RECEBE a chamada e perde a confirmação (destroy).
    runtime.mode = "timeout"; runtime.received = []; runtime.send.mockClear();
    const key = `d-${randomUUID()}`;
    const first = await enviar(key, "Oi incerto");
    expect(first.messageId).toBeTruthy();
    expect(runtime.received.length).toBe(1);
    // a reconciliação volta ao modo ok, mas NÃO re-transporta
    runtime.mode = "ok";
    for (let i = 0; i < 5; i++) {
      const r = await enviar(key, "Oi incerto");
      expect(r.messageId).toBe(first.messageId);
    }
    expect(runtime.received.length).toBe(1);
  });

  it("E: limpeza do idempotency_keys preserva conflito e o payload original recupera", async () => {
    runtime.mode = "ok"; runtime.received = []; runtime.send.mockClear();
    const key = `e-${randomUUID()}`;
    const first = await enviar(key, "payload original");
    // limpeza
    await pool.query("delete from idempotency_keys where organization_id=$1 and endpoint=$2 and key=$3", [org, ENDPOINT, chaveDeIdempotencia(user, key)]);
    // payload diferente → conflito (hash durável no recurso)
    expect((await enviar(key, "payload diferente")).conflito).toBe(true);
    // payload original → recupera a mesma mensagem, sem re-transportar
    expect((await enviar(key, "payload original")).messageId).toBe(first.messageId);
    expect(runtime.received.length).toBe(1);
  });

  it("F: isolamento por organização/ator", async () => {
    const key = `f-${randomUUID()}`;
    const idA = idRecurso(org, user, ENDPOINT, key);
    const otherUser = randomUUID();
    expect(idRecurso(org, otherUser, ENDPOINT, key)).not.toBe(idA);
    const otherOrg = randomUUID();
    expect(idRecurso(otherOrg, user, ENDPOINT, key)).not.toBe(idA);
  });

  it("G: nova operação deliberada com outra chave → segundo recurso + segundo transporte", async () => {
    runtime.mode = "ok"; runtime.received = []; runtime.send.mockClear();
    const a = await enviar(`g-${randomUUID()}-a`, "mesmo texto");
    const b = await enviar(`g-${randomUUID()}-b`, "mesmo texto");
    expect(a.messageId).not.toBe(b.messageId);
    expect(runtime.received.length).toBe(2);
  });
});
