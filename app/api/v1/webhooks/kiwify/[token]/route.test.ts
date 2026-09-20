// @vitest-environment node
import { createHmac } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), source: vi.fn(), decrypt: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.source }) }) }), rpc: mocks.rpc }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: mocks.decrypt }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));
import { POST } from "./route";
const token = "a".repeat(64);
const body = { order_id: "order-test", webhook_event_type: "order_approved", order_status: "paid", Product: { product_id: "test-product" } };
const signature = createHmac("sha1", "synthetic").update(JSON.stringify(body)).digest("hex");
const call = (query = `signature=${signature}`, raw = JSON.stringify(body)) => POST(new Request(`https://test.invalid/api/v1/webhooks/kiwify/${token}?${query}`, { method: "POST", body: raw, headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.source.mockResolvedValue({ data: { id: "source-config", organization_id: "org-config", secret_encrypted: "encrypted", is_active: true } });
  mocks.decrypt.mockResolvedValue("synthetic"); mocks.rate.mockResolvedValue({ allowed: true });
  mocks.rpc.mockResolvedValue({ data: { status: "accepted" } });
});
it.each(["", "signature=bad", `signature=${"0".repeat(40)}`, `signature=${signature}&signature=${signature}`])("não persiste sem autenticação %s", async query => {
  expect((await call(query)).status).toBe(401); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("falha fechada quando não decifra", async () => {
  mocks.decrypt.mockResolvedValue(null); expect((await call()).status).toBe(503); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("organização/integração vêm exclusivamente da fonte; aguarda commit", async () => {
  let finish!: (value: unknown) => void;
  mocks.rpc.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  let done = false; const response = call().then(r => { done = true; return r; });
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
  expect(done).toBe(false);
  expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_organization_id: "org-config", p_integration_id: "source-config" });
  finish({ data: { status: "accepted" } }); expect((await response).status).toBe(200);
});
it.each([["duplicate",200],["ignored",200],["invalid",400],["configuration_error",422],["conflict",409]])("resposta %s", async (status, code) => {
  mocks.rpc.mockResolvedValue({ data: { status } }); expect((await call()).status).toBe(code);
});
it("falha transitória não recebe 2xx; retry pode recuperar", async () => {
  mocks.rpc.mockResolvedValueOnce({ error: { message: "do not expose" } });
  const failed = await call(); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("do not expose");
  expect((await call()).status).toBe(200);
});
