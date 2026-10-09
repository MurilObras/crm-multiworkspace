// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), admin: {} }));
vi.mock("./subscription-lookup", () => ({ refreshSubscriptionState: mocks.refresh }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
import { guardObraFollowup } from "./followup-guard";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime("2026-10-12T12:00:00Z"); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());
it("outros workspaces/contatos e inbound seguem sem consulta ao Obra no Bolso", async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  expect(await guardObraFollowup({ query } as never, "other-org", "job", "contact")).toEqual({ allowed: true });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("j.kind='followup_turn'"), ["other-org","job","contact"]);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("desativação bloqueia follow-up já preparado e não consulta o produto", async () => {
  expect(await guardObraFollowup({ query: vi.fn(async () => ({ rows: [{ state_id: "state", enabled: false }] })) } as never,
    "org", "job", "contact")).toEqual({ allowed: false });
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("revalida recuperação depois de 96h no mesmo job/contato e recusa pagamento/resposta/humano", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ state_id: "state", enabled: true }] }).mockResolvedValueOnce({ rows: [{ live: false }] });
  expect(await guardObraFollowup({ query } as never, "org", "job", "contact")).toEqual({ allowed: false });
  expect(mocks.refresh).toHaveBeenCalledWith(mocks.admin, "org", "state");
  expect(query).toHaveBeenLastCalledWith("select fn_obra_followup_live($1,$2,$3) live", ["org","job","contact"]);
});
it("não manda no sábado; aguarda segunda sem consulta", async () => {
  vi.setSystemTime("2026-10-10T12:00:00Z");
  const query = vi.fn(async () => ({ rows: [{ state_id: "state", enabled: true }] }));
  expect(await guardObraFollowup({ query } as never, "org", "job", "contact")).toEqual({ allowed: false, retryAt: new Date("2026-10-12T11:00:00Z") });
  expect(mocks.refresh).not.toHaveBeenCalled();
});
