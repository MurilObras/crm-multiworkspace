import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mock = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: mock.close }));
import { processObraAccessReceipt } from "./process-receipt";

const org = "11111111-1111-4111-8111-111111111111";
const integration = "22222222-2222-4222-8222-222222222222";
const receipt = "33333333-3333-4333-8333-333333333333";
const lead = "44444444-4444-4444-8444-444444444444";
function admin(claimStatus = "claimed") {
  const rpc = vi.fn(async (name: string) => {
    if (name === "fn_claim_obra_access") return { data: { status: claimStatus, lead_id: lead }, error: null };
    if (name === "fn_finish_obra_access") return { data: { status: "processed" }, error: null };
    return { data: null, error: null };
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("fechamento de recebimento", () => {
  it("usa encerramento compartilhado e finaliza uma vez", async () => {
    mock.close.mockResolvedValueOnce({ lead: { source_metadata: { obra_access_receipt_id: receipt } } });
    const a = admin();
    expect(await processObraAccessReceipt(a.client, org, integration, receipt))
      .toEqual({ status: "processed", receipt_id: receipt });
    expect(mock.close).toHaveBeenCalledWith(a.client,
      expect.objectContaining({ organization_id: org, actor: { type: "webhook_source", id: integration } }),
      { leadId: lead, desfecho: "won", obraAccessReceiptId: receipt });
    expect(a.rpc.mock.calls.map(call => call[0])).toEqual(["fn_claim_obra_access", "fn_finish_obra_access"]);
  });
  it("não fecha de novo quando claim encontra evento processado", async () => {
    mock.close.mockClear();
    const a = admin("duplicate");
    expect(await processObraAccessReceipt(a.client, org, integration, receipt))
      .toEqual({ status: "duplicate", receipt_id: receipt });
    expect(mock.close).not.toHaveBeenCalled();
  });
  it("após falha de fechamento, libera recebimento para retry sem emitir evento", async () => {
    mock.close.mockRejectedValueOnce(new Error("synthetic failure"));
    const a = admin();
    await expect(processObraAccessReceipt(a.client, org, integration, receipt)).rejects.toThrow("synthetic failure");
    expect(a.rpc.mock.calls.map(call => call[0])).toEqual(["fn_claim_obra_access", "fn_release_obra_access"]);
  });
  it("se outra conta fechou o lead, não finaliza o evento", async () => {
    mock.close.mockResolvedValueOnce({ lead: { source_metadata: {} } });
    const a = admin();
    await expect(processObraAccessReceipt(a.client, org, integration, receipt)).rejects.toThrow("closure_identity_mismatch");
    expect(a.rpc.mock.calls.map(call => call[0])).toEqual(["fn_claim_obra_access", "fn_release_obra_access"]);
  });
});
