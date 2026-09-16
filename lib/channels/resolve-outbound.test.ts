import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { resolveOutboundSession, selectOutboundSession, type OutboundSession } from "./resolve-outbound";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";

const session = (over: Partial<OutboundSession> = {}): OutboundSession => ({
  id: "s-1", organization_id: "org-1", provider: "waha", status: "WORKING", archived_at: null, ...over,
});
const input = { organizationId: "org-1" };

describe("seleção de conexão por capability", () => {
  it.each(["waha", "meta_cloud", "zernio"] as const)("org só %s resolve texto", (provider) => {
    expect(selectOutboundSession([session({ provider })], input)?.id).toBe("s-1");
  });
  it("org mista não prefere texto livre fora da janela e independe da ordem", () => {
    const rows = [session(), session({ id: "s-2", provider: "meta_cloud" })];
    expect(selectOutboundSession(rows, input)).toBeNull();
    expect(selectOutboundSession([...rows].reverse(), input)).toBeNull();
  });
  it("mesmo provider com dois números também é ambíguo", () => {
    expect(selectOutboundSession([session(), session({ id: "s-2" })], input)).toBeNull();
  });
  it("template oficial exige capability de definições aprovadas", () => {
    const rows = [session(), session({ id: "s-2", provider: "meta_cloud" })];
    expect(selectOutboundSession(rows, { ...input, kind: "template" })?.id).toBe("s-2");
    expect(selectOutboundSession(rows, { ...input, kind: "template", sessionId: "s-1" })).toBeNull();
  });
  it.each([
    { archived_at: "2026-09-14" }, { organization_id: "org-2" }, { status: "STOPPED" },
    { status: "STARTING" }, { status: "unknown" }, { provider: "unknown" as OutboundSession["provider"] },
  ])("ignora sessão inelegível %j", (over) => {
    expect(selectOutboundSession([session(over)], input)).toBeNull();
    expect(selectOutboundSession([session(over), session({ id: "s-2" })], input)?.id).toBe("s-2");
  });
  it("sem conexão elegível falha fechado", () => {
    expect(selectOutboundSession([], input)).toBeNull();
  });
  it("sessão explícita jamais cai em outro número", () => {
    expect(selectOutboundSession([session({ archived_at: "2026-09-14" }), session({ id: "s-2" })],
      { ...input, sessionId: "s-1" })).toBeNull();
  });
});

type Row = Record<string, unknown>;
function fakeDb(sessions: OutboundSession[], conversations: Row[] = [], missingArchived = false, readError = false) {
  const calls: Array<{ table: string; filters: string[] }> = [];
  const from = (table: string) => {
    const call = { table, filters: [] as string[] }; calls.push(call);
    const predicates: Array<(r: Row) => boolean> = [];
    let columns = "";
    const result = () => {
      if (readError) return { data: null, error: { message: "db unavailable" } };
      if (missingArchived && columns.includes("archived_at")) {
        return { data: null, error: { code: "42703", message: "column channel_sessions.archived_at does not exist" } };
      }
      const source = table === "channel_sessions" ? sessions : conversations;
      return { data: source.filter((r) => predicates.every((p) => p(r as unknown as Row))), error: null };
    };
    const q = {
      select(c: string) { columns = c; return q; },
      eq(c: string, v: unknown) { call.filters.push(`${c}=${v}`); predicates.push((r) => r[c] === v); return q; },
      is(c: string, v: null) { call.filters.push(`${c}=null`); predicates.push((r) => r[c] === v); return q; },
      order() { return q; }, limit() { return q; },
      async maybeSingle() { const r = result(); return { ...r, data: r.data?.[0] ?? null }; },
      async then(resolve: (v: ReturnType<typeof result>) => unknown) { return resolve(result()); },
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, calls };
}
const conversation = (over: Row = {}): Row => ({
  id: "conv-1", organization_id: "org-1", contact_id: "contact-1", channel_session_id: "s-1", is_group: false, status: "open", ...over,
});

describe("resolvedor Supabase e consumidores de conversa", () => {
  it("mantém conexão da conversa em org mista", async () => {
    const { db, calls } = fakeDb([session({ provider: "meta_cloud" }), session({ id: "s-2" })], [conversation()]);
    expect(await sessaoProntaParaEnvio(db, "org-1", "contact-1")).toBe("s-1");
    expect(calls.every((c) => c.filters.includes("organization_id=org-1"))).toBe(true);
  });
  it("vínculo arquivado não autoriza substituir por conexão ativa", async () => {
    const { db } = fakeDb([session({ archived_at: "2026-09-14" }), session({ id: "s-2" })], [conversation()]);
    expect(await sessaoProntaParaEnvio(db, "org-1", "contact-1")).toBeNull();
  });
  it("múltiplos vínculos exigem sessão explícita", async () => {
    const { db } = fakeDb([session(), session({ id: "s-2" })], [conversation(), conversation({ channel_session_id: "s-2" })]);
    expect(await sessaoProntaParaEnvio(db, "org-1", "contact-1")).toBeNull();
    expect(await sessaoProntaParaEnvio(db, "org-1", "contact-1", "s-2")).toBe("s-2");
  });
  it("conversa de outro tenant ou grupo não decide o remetente", async () => {
    const { db } = fakeDb([session()], [conversation({ organization_id: "org-2", channel_session_id: "s-2" }),
      conversation({ is_group: true, channel_session_id: "s-3" })]);
    expect(await sessaoProntaParaEnvio(db, "org-1", "contact-1")).toBe("s-1");
  });
  it("filtra arquivamento na leitura e tolera apenas coluna ausente", async () => {
    const { db, calls } = fakeDb([session()], [], true);
    expect((await resolveOutboundSession(db, input))?.id).toBe("s-1");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.filters).toContain("archived_at=null");
    expect(calls[1]?.filters).not.toContain("archived_at=null");
  });
  it("erro de leitura não vira outra conexão", async () => {
    const { db } = fakeDb([session()], [], false, true);
    await expect(resolveOutboundSession(db, input)).rejects.toThrow("outbound_session_lookup_failed");
  });
  it.each([{ organization_id: "org-2" }, { archived_at: "2026-09-14" }, { status: "STOPPED" }])(
    "ensureConversation recusa sessão explícita inelegível %j antes de criar/reabrir", async (over) => {
      const { db, calls } = fakeDb([session(over)]);
      await expect(ensureConversation(db, "org-1", "contact-1", "s-1")).rejects.toThrow("outbound_session_unavailable");
      expect(calls.every((c) => c.table === "channel_sessions")).toBe(true);
    },
  );
  it("ensureConversation preserva conversa existente na sessão explícita", async () => {
    const { db } = fakeDb([session()], [conversation()]);
    expect(await ensureConversation(db, "org-1", "contact-1", "s-1")).toBe("conv-1");
  });
});
