/** Fecha apenas um recebimento conciliado, usando a regra compartilhada de leads. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { encerraDemanda } from "@/lib/leads/encerramento";

export async function processObraAccessReceipt(admin: SupabaseClient, organizationId: string,
  integrationId: string, receiptId: string): Promise<{ status: string; receipt_id: string }> {
  const { data: claim, error: claimError } = await admin.rpc("fn_claim_obra_access", {
    p_organization_id: organizationId, p_receipt_id: receiptId,
  });
  if (claimError || !claim) throw new Error("claim_unavailable");
  if (claim.status !== "claimed") return { status: claim.status as string, receipt_id: receiptId };
  try {
    const { lead } = await encerraDemanda(admin, {
      organization_id: organizationId,
      actor: { type: "webhook_source", id: integrationId },
      requestId: randomUUID(),
    }, { leadId: claim.lead_id as string, desfecho: "won", obraAccessReceiptId: receiptId });
    if ((lead.source_metadata as Record<string, unknown> | undefined)?.obra_access_receipt_id !== receiptId) {
      throw new Error("closure_identity_mismatch");
    }
    const { data: finished, error: finishError } = await admin.rpc("fn_finish_obra_access", {
      p_organization_id: organizationId, p_receipt_id: receiptId,
    });
    if (finishError || !finished || finished.status !== "processed") throw new Error("finish_unavailable");
    return { status: "processed", receipt_id: receiptId };
  } catch (error) {
    await admin.rpc("fn_release_obra_access", {
      p_organization_id: organizationId, p_receipt_id: receiptId,
    });
    throw error;
  }
}
