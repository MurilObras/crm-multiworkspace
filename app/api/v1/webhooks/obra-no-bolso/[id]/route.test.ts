// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ lifecycle: true, active: true, status: "accepted", error: false, rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({
    data: { id: "894eb39f-7969-46be-85dc-613070985152", organization_id: "trusted-org", secret_encrypted: "encrypted",
      is_active: state.active, lifecycle_enabled: state.lifecycle }, error: null }) }; return q; }, rpc: state.rpc,
}) }));
vi.mock("@/lib/obra-no-bolso/rate-limit", () => ({ checkObraAccessRate: async () => true }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "synthetic-test-secret" }));
vi.mock("@/lib/obra-no-bolso/process-receipt", () => ({ processObraAccessReceipt: vi.fn() }));
import { POST } from "./route";

const checked = new Date(Date.now() - 60_000).toISOString();
function event() {
  return { version: 2, event_type: "subscription_status_checked", event_id: randomUUID(), product_user_id: randomUUID(),
    occurred_at: checked, checked_at: checked, trial_started_at: new Date(Date.parse(checked) - 96 * 3600_000).toISOString(),
    name: "Synthetic", email: "test@example.invalid", phone: "+5511999990000", status_pagamento: "ativo",
    em_trial: false, access_enabled: true, trial_ends_at: null, access_expires_at: null };
}
const context = { params: Promise.resolve({ id: "894eb39f-7969-46be-85dc-613070985152" }) };
function request(input: unknown, validSignature = true) {
  const body = JSON.stringify(input), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", validSignature ? "synthetic-test-secret" : "wrong-secret").update(`${timestamp}.${body}`).digest("hex");
  return new Request("https://crm.example.invalid/api/v1/webhooks/obra-no-bolso/source?organization_id=forged", {
    method: "POST", body, headers: { "content-type": "application/json", "x-obra-timestamp": timestamp, "x-obra-signature": `v1=${signature}` },
  });
}
beforeEach(() => {
  vi.clearAllMocks(); state.lifecycle = true; state.active = true; state.status = "accepted"; state.error = false;
  state.rpc.mockImplementation(async (name: string, args: { p_payload?: { event_id: string } }) => ({
    data: name === "fn_receive_obra_subscription" ? { status: state.status, event_id: args.p_payload?.event_id, decision: "paid" } : null,
    error: state.error ? { message: "synthetic-private-db-detail" } : null,
  }));
});
it.each(["accepted", "duplicate"])("ACK %s preserva ID e usa workspace da integração", async status => {
  state.status = status; const input = event();
  const response = await POST(request(input), context);
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ status, event_id: input.event_id });
  expect(state.rpc).toHaveBeenCalledWith("fn_receive_obra_subscription", expect.objectContaining({ p_org: "trusted-org", p_secret_encrypted: "encrypted" }));
});
it("HMAC inválido não alcança o consumidor", async () => {
  expect((await POST(request(event(),false),context)).status).toBe(401);
  expect(state.rpc.mock.calls.some(([name]) => name === "fn_receive_obra_subscription")).toBe(false);
});
it.each(["legacy", "extra_org", "early"])("modo v2 recusa %s antes de persistir", async kind => {
  const input = event();
  const body = kind === "legacy" ? { ...input, version: 1, event_type: "first_access_granted" }
    : kind === "extra_org" ? { ...input, organization_id: "forged" }
    : { ...input, checked_at: new Date(Date.parse(checked) - 1000).toISOString() };
  expect((await POST(request(body),context)).status).toBe(422);
  expect(state.rpc.mock.calls.some(([name]) => name === "fn_receive_obra_subscription")).toBe(false);
});
it("default legado não aceita contrato v2 implicitamente", async () => {
  state.lifecycle = false;
  expect((await POST(request(event()),context)).status).toBe(400);
  expect(state.rpc.mock.calls.some(([name]) => name === "fn_receive_obra_subscription")).toBe(false);
});
it("inativo, colisão e indisponibilidade são respostas distintas, sem erro privado", async () => {
  state.active = false;
  expect((await POST(request(event()),context)).status).toBe(404);
  state.active = true; state.status = "conflict";
  expect((await POST(request(event()),context)).status).toBe(409);
  state.error = true;
  const response = await POST(request(event()),context);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("synthetic-private-db-detail");
});
