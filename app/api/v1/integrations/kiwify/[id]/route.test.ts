// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ role: vi.fn(), encrypt: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: mocks.encrypt }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
import { PATCH, DELETE } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
const config = { name: "Synthetic", store_id: "store", pipeline_id: id, stage_id: id, products: [{ external_product_id: "sku", product_id: id }] };
const request = (body: unknown) => new Request("https://test.invalid/kiwify", { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue({ ok: true, org: { orgId: "trusted-org" }, user: { id: "trusted-actor" } });
  mocks.rpc.mockResolvedValue({ data: id, error: null }); mocks.encrypt.mockResolvedValue("ciphertext");
});
it.each([undefined, ""])('secret %s preserva cifra sem retornar segredo/token/URL', async secret => {
  const response = await PATCH(request({ ...config, secret }), context);
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { integration_id: id } });
  expect(mocks.encrypt).not.toHaveBeenCalled();
  expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_organization_id: "trusted-org", p_actor_user_id: "trusted-actor", p_secret_encrypted: null, p_operation: "edit" });
  expect(mocks.rpc.mock.calls[0]?.[1].p_config).not.toHaveProperty("path_token");
});
it("rotação é write-only; arquivamento usa RPC de soft delete", async () => {
  const response=await PATCH(request({ ...config, secret: "synthetic-rotation" }),context);
  expect(await response.text()).not.toContain("synthetic-rotation");
  expect(mocks.rpc.mock.calls[0]?.[1].p_secret_encrypted).toBe("ciphertext");
  await DELETE(request({}),context);
  expect(mocks.rpc.mock.calls[1]?.[1].p_operation).toBe("archive");
});
it("recusa organização/token injetados e autorização é anterior à cifra", async () => {
  expect((await PATCH(request({ ...config, organization_id: "foreign" }),context)).status).toBe(400);
  expect((await PATCH(request({ ...config, path_token: "change-url" }),context)).status).toBe(400);
  mocks.role.mockResolvedValue({ ok:false,response:new Response(null,{status:403}) });
  expect((await PATCH(request({ ...config, secret:"hidden" }),context)).status).toBe(403);
  expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.encrypt).not.toHaveBeenCalled();
});
it("Store ID duplicado devolve erro específico sem detalhe SQL", async () => {
  mocks.rpc.mockResolvedValue({ error:{code:"23505",message:"secret must not escape"} });
  const response=await PATCH(request(config),context);
  expect(response.status).toBe(409);const text=await response.text();expect(text).toContain("Store ID duplicado");expect(text).not.toContain("secret must not escape");
});
