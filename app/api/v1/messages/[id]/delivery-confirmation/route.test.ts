import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import {
  confirmVideoDelivery,
  VideoConfirmationConflict,
} from "@/lib/channels/confirm-video-delivery";
import { POST } from "./route";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/channels/confirm-video-delivery", () => ({
  confirmVideoDelivery: vi.fn(),
  VideoConfirmationConflict: class extends Error {},
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
const org = "10000000-0000-4000-8000-000000000001",
  id = "20000000-0000-4000-8000-000000000001",
  echo = "20000000-0000-4000-8000-000000000002";
const ctx = { params: Promise.resolve({ id }) };
const request = (body: unknown) =>
  new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: org },
    user: { id: "manager" },
  } as never);
  vi.mocked(confirmVideoDelivery).mockResolvedValue({
    id,
    conversation_id: "conversation",
    replay: false,
  });
});
describe("confirmar entrega de vídeo", () => {
  it("exige confirmação humana explícita e não aceita escolher o workspace pelo corpo", async () => {
    for (const body of [
      { echo_id: echo },
      { echo_id: echo, confirmed_same_video: false },
      { echo_id: echo, confirmed_same_video: true, organization_id: "outra-org" },
    ]) {
      expect((await POST(request(body), ctx)).status).toBe(422);
    }
    expect(confirmVideoDelivery).not.toHaveBeenCalled();
  });
  it("usa o workspace autenticado e exige gerente", async () => {
    expect((await POST(request({ echo_id: echo, confirmed_same_video: true }), ctx)).status).toBe(
      200,
    );
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(confirmVideoDelivery).toHaveBeenCalledWith(expect.anything(), org, id, echo);
  });
  it("nega sem executar quando não há autorização", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await POST(request({ echo_id: echo, confirmed_same_video: true }), ctx)).status).toBe(
      403,
    );
    expect(confirmVideoDelivery).not.toHaveBeenCalled();
  });
  it("conflito concorrente é 409, sem expor erro do banco", async () => {
    vi.mocked(confirmVideoDelivery).mockRejectedValue(new VideoConfirmationConflict());
    expect((await POST(request({ echo_id: echo, confirmed_same_video: true }), ctx)).status).toBe(
      409,
    );
  });
});
