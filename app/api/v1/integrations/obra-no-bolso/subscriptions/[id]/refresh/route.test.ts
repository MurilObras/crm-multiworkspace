// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ allowed: true, rate: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async (role: string) => {
  expect(role).toBe("admin");return mocks.allowed ? { ok: true, user: { id: "actor" }, org: { orgId: "trusted-org" } }
    : { ok: false, response: new Response(null,{ status:403 }) };
} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/obra-no-bolso/rate-limit", () => ({ checkObraAccessRate: mocks.rate }));
vi.mock("@/lib/obra-no-bolso/subscription-lookup", () => ({ refreshSubscriptionState: mocks.refresh }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { POST } from "./route";
const id = "2c3f3457-9a52-4fd3-9e51-9e9842ff4c5a";
const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ organization_id:"forged" }) });
beforeEach(() => { vi.clearAllMocks(); mocks.allowed=true;mocks.rate.mockResolvedValue(true);
  mocks.refresh.mockResolvedValue({ status:"accepted", state_id:id, decision:"manual", reason:"status_still_trial" }); });
it("reconsulta o estado identificado pela URL, sempre no workspace da sessão", async () => {
  expect((await POST(request(), { params:Promise.resolve({ id }) })).status).toBe(200);
  expect(mocks.refresh).toHaveBeenCalledWith({}, "trusted-org", id);
});
it("permissão, identificador inválido e limite impedem a consulta", async () => {
  mocks.allowed=false;
  expect((await POST(request(),{ params:Promise.resolve({ id }) })).status).toBe(403);
  mocks.allowed=true;
  expect((await POST(request(),{ params:Promise.resolve({ id:"forged" }) })).status).toBe(404);
  mocks.rate.mockResolvedValue(false);
  expect((await POST(request(),{ params:Promise.resolve({ id }) })).status).toBe(429);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("falha do backend não fabrica conversão nem expõe dados internos", async () => {
  mocks.refresh.mockRejectedValue(new Error("synthetic-private-server-detail"));
  const response = await POST(request(),{ params:Promise.resolve({ id }) });
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-private-server-detail");
});
