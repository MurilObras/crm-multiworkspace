import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";

const SECRET = "status-test-secret";
const SESSION = { id: "session-a", organizationId: "org-a", wabaId: "waba-a" };
type Row = Record<string, unknown>;
let rows: Row[];
let writes: number;
let dbError: boolean;
let readError: boolean;
let lookupHook: (() => void) | null;
let lookupPhase: "before" | "after";
const resolveSession = vi.fn(async (_token: string) => SESSION as typeof SESSION | null);
vi.mock("@/lib/channels/meta/session", () => ({ metaSessionByWebhookToken: (token: string) => resolveSession(token) }));
vi.mock("@/lib/channels/meta/ingest", () => ({ ingestMetaInbound: vi.fn(async () => ({ status: "ingested" })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db() }));

/** Executa predicados no momento do UPDATE (inclusive concorrência), como o banco.
 * Assim retirar filtro de tenant/sessão/status muda linhas e reprova os casos. */
function db() {
  return {
    from(table: string) {
      expect(table).toBe("messages");
      return {
        select() {
          const predicates: Array<(row: Row) => boolean> = [];
          const q = {
            eq(column: string, value: unknown) { predicates.push((r) => r[column] === value); return q; },
            async maybeSingle() {
              if (readError) return { data: null, error: { message: "database unavailable" } };
              const hook = lookupHook; lookupHook = null;
              if (lookupPhase === "before") hook?.();
              const row = rows.find((r) => predicates.every((p) => p(r)));
              const data = row ? { id: row.id } : null;
              if (lookupPhase === "after") hook?.();
              return { data, error: null };
            },
          };
          return q;
        },
        update(patch: Row) {
        const predicates: Array<(row: Row) => boolean> = [];
        const q = {
          eq(column: string, value: unknown) { predicates.push((r) => r[column] === value); return q; },
          neq(column: string, value: unknown) { predicates.push((r) => r[column] !== value); return q; },
          in(column: string, values: string[]) { predicates.push((r) => values.includes(String(r[column]))); return q; },
          or(filter: string) {
            const [nullFilter, gtFilter] = filter.split(",");
            const column = nullFilter!.split(".")[0]!;
            const at = gtFilter!.slice(`${column}.gt.`.length);
            predicates.push((r) => r[column] === null || String(r[column]) > at);
            return q;
          },
          async then(resolve: (result: { error: { message: string } | null }) => unknown) {
            if (dbError) return resolve({ error: { message: "database unavailable" } });
            for (const row of rows) {
              if (predicates.every((p) => p(row))) { Object.assign(row, patch); writes++; }
            }
            return resolve({ error: null });
          },
        };
        return q;
      } };
    },
  };
}

function message(extra: Row = {}): Row {
  return {
    id: "message-a", organization_id: "org-a", channel_session_id: "session-a",
    external_id: "wamid.A", direction: "outbound", status: "queued",
    sent_at: "2026-09-14T12:00:00.000Z", delivered_at: null, read_at: null,
    error_code: null, error_message: null, ...extra,
  };
}

function envelope(status: string, extra: Row = {}, wabaId = "waba-a") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: wabaId, changes: [{ field: "messages", value: {
      statuses: [{ id: "wamid.A", status, timestamp: "1700000000", ...extra }],
    } }] }],
  };
}

async function post(status: string, extra: Row = {}, wabaId = "waba-a", signature = true) {
  return postEnvelope(envelope(status, extra, wabaId), signature);
}

async function postEnvelope(payload: ReturnType<typeof envelope>, signature = true) {
  const raw = JSON.stringify(payload);
  return POST({
    text: async () => raw,
    headers: new Headers({ "x-hub-signature-256": signature
      ? `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` : "invalid" }),
  } as never, { params: Promise.resolve({ token: "trusted-path-token" }) });
}

beforeEach(() => {
  rows = [message()]; writes = 0; dbError = false;
  readError = false;
  lookupHook = null; lookupPhase = "after";
  resolveSession.mockResolvedValue(SESSION);
  vi.stubEnv("META_APP_SECRET", SECRET);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("webhook Meta — recibos monotônicos e isolados", () => {
  it("falha na leitura da correlação também pede retry, sem confirmar nem escrever", async () => {
    readError = true;
    expect((await post("delivered")).status).toBe(500);
    expect(writes).toBe(0);
    readError = false;
    expect((await post("delivered")).status).toBe(200);
    expect(rows[0]?.status).toBe("delivered");
  });
  it.each(["sent", "delivered", "read", "failed"])("%s antecipado pede retry e aplica após external_id aparecer", async (status) => {
    rows[0]!.external_id = null;
    const event = { errors: [{ code: 131047, title: "Window closed" }] };
    const pending = await post(status, event);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ error: { details: {
      pending_receipts: 1, outcomes: ["pending_correlation"],
    } } });
    expect(writes).toBe(0);
    // O mesmo UPDATE que o sink faz ao receber o wamid do transporte.
    Object.assign(rows[0]!, { external_id: "wamid.A", status: "sent" });
    expect((await post(status, event)).status).toBe(200);
    expect(rows[0]?.status).toBe(status);
    if (status === "delivered") expect(rows[0]?.delivered_at).toBe("2023-11-14T22:13:20.000Z");
    if (status === "read") expect(rows[0]?.read_at).toBe("2023-11-14T22:13:20.000Z");
    if (status === "failed") expect(rows[0]).toMatchObject({ error_code: "131047", error_message: "Window closed" });
    writes = 0;
    expect((await post(status, event)).status).toBe(200);
    expect(writes).toBe(0);
  });

  it.each(["before", "after"] as const)("external_id gravado %s da leitura concorrente não perde recibo", async (phase) => {
    rows[0]!.external_id = null;
    lookupPhase = phase;
    lookupHook = () => Object.assign(rows[0]!, { external_id: "wamid.A", status: "sent" });
    expect((await post("read")).status).toBe(phase === "before" ? 200 : 503);
    expect((await post("read")).status).toBe(200);
    expect(rows[0]).toMatchObject({ status: "read", read_at: "2023-11-14T22:13:20.000Z" });
    await post("delivered", { timestamp: "1699999999" });
    await post("failed");
    expect(rows[0]?.status).toBe("read");
  });

  it.each([{ organization_id: "org-b" }, { channel_session_id: "session-b" }, { direction: "inbound" }])(
    "recibo sem mensagem no escopo pede retry, nunca correlaciona %j", async (other) => {
      rows = [message(other)];
      const before = structuredClone(rows);
      expect((await post("read", { organization_id: "org-b", channel_session_id: "session-b" })).status).toBe(503);
      expect(rows).toEqual(before); expect(writes).toBe(0);
    },
  );

  it("mensagem inexistente permanece pendente e não inventa uma linha", async () => {
    rows = [];
    expect((await post("delivered")).status).toBe(503);
    expect((await post("delivered")).status).toBe(503);
    expect(rows).toEqual([]); expect(writes).toBe(0);
  });

  it("um recibo pendente não impede os correlacionáveis do mesmo lote", async () => {
    const payload = envelope("read", { id: "wamid.PENDING" });
    payload.entry[0]!.changes[0]!.value.statuses.push({ id: "wamid.A", status: "delivered", timestamp: "1700000000" });
    expect((await postEnvelope(payload)).status).toBe(503);
    expect(rows[0]?.status).toBe("delivered");
    writes = 0;
    expect((await postEnvelope(payload)).status).toBe(503);
    expect(writes).toBe(0);
    rows.push(message({ id: "message-b", external_id: "wamid.PENDING", status: "sent" }));
    expect((await postEnvelope(payload)).status).toBe(200);
    expect(rows[1]?.status).toBe("read");
  });

  it.each(["sent", "delivered", "read"])("%s preserva o status e o timestamp real", async (status) => {
    expect((await post(status)).status).toBe(200);
    const column = status === "sent" ? "sent_at" : status === "delivered" ? "delivered_at" : "read_at";
    expect(rows[0]).toMatchObject({ status, [column]: "2023-11-14T22:13:20.000Z" });
  });

  it("failed preserva código e detalhes da Meta", async () => {
    await post("failed", { errors: [{ code: 131047, title: "Re-engagement message", message: "generic", error_data: { details: "Window closed" } }] });
    expect(rows[0]).toMatchObject({ status: "failed", error_code: "131047", error_message: "Window closed" });
  });

  it.each([
    [{ code: 1, message: "Mensagem" }, "Mensagem"],
    [{ code: 1, title: "Título" }, "Título"],
    [{}, null],
  ])("failed aceita erro parcial %j", async (error, expected) => {
    await post("failed", { errors: [error] });
    expect(rows[0]).toMatchObject({ status: "failed", error_message: expected });
  });

  it.each(["sent", "delivered", "read", "failed"])("%s duplicado não faz nova escrita", async (status) => {
    await post(status);
    const snapshot = structuredClone(rows);
    writes = 0;
    await post(status);
    expect(rows).toEqual(snapshot);
    expect(writes).toBe(0);
  });

  it("read seguido de delivered/sent atrasados preenche recibos sem regredir", async () => {
    await post("read", { timestamp: "1700000002" });
    await post("delivered", { timestamp: "1700000001" });
    await post("sent");
    expect(rows[0]).toMatchObject({ status: "read", sent_at: "2023-11-14T22:13:20.000Z",
      delivered_at: "2023-11-14T22:13:21.000Z", read_at: "2023-11-14T22:13:22.000Z" });
  });

  it("delivered seguido de sent permanece delivered", async () => {
    await post("delivered"); await post("sent");
    expect(rows[0]?.status).toBe("delivered");
  });

  it("recibos concorrentes não rebaixam read", async () => {
    await Promise.all([post("read"), post("sent"), post("delivered")]);
    expect(rows[0]?.status).toBe("read");
  });

  it.each(["delivered", "read", "failed"])("%s é preservado diante de falha/sent tardios", async (status) => {
    await post(status);
    await post("failed", { errors: [{ code: 1, title: "late" }] });
    await post("sent");
    expect(rows[0]?.status).toBe(status);
  });

  it.each(["delivered", "read"])("failed terminal não vira %s em recibo atrasado", async (status) => {
    await post("failed"); await post(status);
    expect(rows[0]).toMatchObject({ status: "failed", delivered_at: null, read_at: null });
  });

  it("status desconhecido é ignorado explicitamente, sem escrita", async () => {
    const response = await post("future_status");
    expect(await response.json()).toMatchObject({ outcomes: ["ignored_status"] });
    expect(rows[0]?.status).toBe("queued"); expect(writes).toBe(0);
  });

  it.each([undefined, "inválido", "999999999999999999999"])("timestamp %s usa recebimento sem regravar na duplicata", async (timestamp) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    await post("delivered", { timestamp });
    expect(rows[0]?.delivered_at).toBe("2026-09-14T12:00:00.000Z");
    vi.setSystemTime(new Date("2026-09-14T12:01:00Z")); writes = 0;
    await post("delivered", { timestamp });
    expect(writes).toBe(0);
  });

  it("sent já persistido pelo sink recebe o timestamp real", async () => {
    rows[0] = message({ status: "sent", sent_at: "2023-11-14T22:13:19.000Z" }); await post("sent");
    expect(rows[0]?.sent_at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("filtra organização, sessão, ID externo e direção usando o token", async () => {
    const others = [message({ organization_id: "org-b" }), message({ channel_session_id: "session-b" }),
      message({ external_id: "wamid.B" }), message({ direction: "inbound" })];
    rows.push(...structuredClone(others));
    await post("read", { organization_id: "org-b", channel_session_id: "session-b" });
    expect(resolveSession).toHaveBeenCalledWith("trusted-path-token");
    expect(rows[0]?.status).toBe("read"); expect(rows.slice(1)).toEqual(others);
  });

  it("WABA diferente não altera mensagem", async () => {
    await post("read", {}, "waba-b"); expect(writes).toBe(0);
  });

  it("token desconhecido e assinatura inválida não escrevem", async () => {
    expect((await post("sent", {}, "waba-a", false)).status).toBe(401);
    resolveSession.mockResolvedValue(null);
    expect((await post("sent")).status).toBe(404); expect(writes).toBe(0);
  });

  it("erro de persistência pede reentrega em vez de confirmar perda", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbError = true;
    expect((await post("delivered")).status).toBe(500);
    dbError = false;
    expect((await post("delivered")).status).toBe(200);
    expect(rows[0]?.status).toBe("delivered");
  });

  it("parser preserva recibos quando há inbound no mesmo change", () => {
    const payload = envelope("delivered");
    Object.assign(payload.entry[0]!.changes[0]!.value, {
      messages: [{ id: "wamid.IN", from: "5511999999999", type: "text", text: { body: "oi" }, timestamp: "1700000000" }],
    });
    expect(parseMetaWebhook(payload).map((e) => e.kind)).toEqual(["inbound_message", "message_status"]);
  });
});
