// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ role: vi.fn(), encrypt: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: mocks.encrypt }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
import { POST } from "./route";
const config = { name: "Synthetic", store_id: "store-test", secret: "synthetic-only", pipeline_id: "11111111-1111-4111-8111-111111111111", stage_id: "22222222-2222-4222-8222-222222222222", products: [{ external_product_id: "product-test", product_id: "33333333-3333-4333-8333-333333333333" }] };
const call = (body = config) => POST(new Request("https://test.invalid/api/v1/integrations/kiwify", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue({ ok: true, org: { orgId: "org-session" }, user: { id: "actor-session" } });
  mocks.encrypt.mockResolvedValue("encrypted"); mocks.rpc.mockResolvedValue({ data: "integration" });
});
it("manager obrigatório antes de ler/cifrar dados", async () => {
  mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await call()).status).toBe(403); expect(mocks.encrypt).not.toHaveBeenCalled();
});
it("cifra write-only e organização exclusivamente da sessão", async () => {
  const r = await call(); expect(r.status).toBe(201);
  expect(await r.text()).not.toContain("synthetic-only");
  expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_organization_id: "org-session", p_secret_encrypted: "encrypted" });
  expect(mocks.rpc.mock.calls[0]?.[1].p_config).not.toHaveProperty("secret");
});
it("cifra indisponível e produtos ausentes impedem configuração", async () => {
  expect((await call({ ...config, products: [] })).status).toBe(400);
  mocks.encrypt.mockResolvedValue(null);
  expect((await call()).status).toBe(422); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("rejeita IDs duplicados no mapeamento e organização injetada", async () => {
  expect((await call({ ...config, products: [...config.products, ...config.products] })).status).toBe(400);
  expect((await call(Object.assign({}, config, { organization_id: "forged" }))).status).toBe(400);
});
it("ator vem da autenticação do servidor e é propagado para a RPC", async () => {
  expect((await call()).status).toBe(201);
  expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_actor_user_id: "actor-session", p_organization_id: "org-session" });
});
it.each(["actor_user_id", "p_actor_user_id"])("recusa falsificação de ator pelo payload: %s", async field => {
  expect((await call(Object.assign({}, config, { [field]: "forged-actor" }))).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
