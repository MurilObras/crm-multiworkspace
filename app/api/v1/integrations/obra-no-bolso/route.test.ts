// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ allowed: true, from: vi.fn(), rpc: vi.fn(), eq: vi.fn(), range: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(async (role: string) => {
  expect(role).toBe("admin");
  return state.allowed ? { ok: true, user: { id: "actor" }, org: { orgId: "trusted-org" } }
    : { ok: false, response: Response.json({ error: { code: "forbidden_role" } }, { status: 403 }) };
}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: state.from, rpc: state.rpc }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks(); state.allowed = true;
  state.rpc.mockResolvedValue({ data: { processed: 1500, pending: 1200, duplicates: 2400, rejected: 0, trial: 500, paid: 1000 }, error: null });
  state.from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { state.eq(table, key, value); return query; },
      order: () => query,
      range: (start: number, end: number) => { state.range(start, end); return query; },
      limit: () => query,
      maybeSingle: async () => ({ data: { id: "source", organization_id: "trusted-org", is_active: false }, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ error: null,
        data: table === "obra_access_receipts" ? Array.from({ length: 51 }, (_, n) => ({ id: `receipt-${n}` })) : [] }),
    };
    return query;
  });
});

it("somente administrador lê histórico, antes de tocar no banco", async () => {
  state.allowed = false;
  expect((await GET(new Request("http://localhost/api/v1/integrations/obra-no-bolso"))).status).toBe(403);
  expect(state.from).not.toHaveBeenCalled();
});

it("pendências antigas são paginadas e os totais vêm da agregação do workspace", async () => {
  const response = await GET(new Request("http://localhost/api/v1/integrations/obra-no-bolso?offset=50&status=pending&organization_id=forged"));
  expect(response.status).toBe(200);
  const { data } = await response.json();
  expect(data.receipts).toHaveLength(50);
  expect(data.pagination).toEqual({ offset: 50, has_more: true });
  expect(data.counts.pending).toBe(1200);
  expect(state.range).toHaveBeenCalledWith(50, 100);
  expect(state.eq).toHaveBeenCalledWith("obra_access_receipts", "status", "pending");
  expect(state.eq).toHaveBeenCalledWith("obra_access_receipts", "organization_id", "trusted-org");
  expect(state.rpc).toHaveBeenCalledWith("fn_obra_access_counts", { p_organization_id: "trusted-org", p_integration_id: "source" });
});

it.each(["offset=-1", "offset=NaN", "status=forged"])("recusa filtro inválido: %s", async query => {
  expect((await GET(new Request(`http://localhost/api/v1/integrations/obra-no-bolso?${query}`))).status).toBe(400);
  expect(state.from).not.toHaveBeenCalled();
});

it("falha de métricas não publica histórico parcial nem detalhes do banco", async () => {
  state.rpc.mockResolvedValueOnce({ data: null, error: { message: "synthetic-secret" } });
  const response = await GET(new Request("http://localhost/api/v1/integrations/obra-no-bolso"));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("synthetic-secret");
});
