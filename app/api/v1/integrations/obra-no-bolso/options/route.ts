import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const receiptId = url.searchParams.get("receipt_id");
  const contactId = url.searchParams.get("contact_id");
  const search = url.searchParams.get("search")?.trim() ?? "";
  if (!z.uuid().safeParse(receiptId).success || search.length > 100 ||
      (contactId && !z.uuid().safeParse(contactId).success)) {
    return fail("invalid_request", "Consulta inválida.", 400, { requestId });
  }
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: receipt } = await admin.from("obra_access_receipts")
    .select("id,integration_id,status").eq("organization_id", orgId).eq("id", receiptId!).maybeSingle();
  if (!receipt || receipt.status !== "pending") return fail("not_found", "Pendente não encontrado.", 404, { requestId });
  const { data: integration } = await admin.from("obra_access_integrations")
    .select("pipeline_id").eq("organization_id", orgId).eq("id", receipt.integration_id).maybeSingle();
  if (!integration) return fail("not_found", "Integração não encontrada.", 404, { requestId });
  if (contactId) {
    const { data: contact } = await admin.from("contacts").select("id")
      .eq("organization_id", orgId).eq("id", contactId).is("is_merged_into", null)
      .eq("is_anonymized", false).maybeSingle();
    if (!contact) return ok({ contacts: [], leads: [] }, { requestId });
    const { data: leads, error } = await admin.from("crm_leads")
      .select("id,title,stage_id,status").eq("organization_id", orgId)
      .eq("pipeline_id", integration.pipeline_id).eq("contact_id", contactId)
      .eq("status", "open").order("created_at", { ascending: false }).limit(30);
    if (error) return fail("internal_error", "Oportunidades indisponíveis.", 503, { requestId });
    return ok({ contacts: [], leads: leads ?? [] }, { requestId });
  }
  if (search.length < 2) return ok({ contacts: [], leads: [] }, { requestId });
  const escaped = search.replace(/[%_]/g, "\\$&").replace(/[,()]/g, " ");
  const { data: contacts, error } = await admin.from("contacts")
    .select("id,name,email,phone_number").eq("organization_id", orgId)
    .is("is_merged_into", null).eq("is_anonymized", false)
    .or(`name.ilike.%${escaped}%,email.ilike.%${escaped}%,phone_number.ilike.%${escaped}%`)
    .limit(20);
  if (error) return fail("internal_error", "Contatos indisponíveis.", 503, { requestId });
  return ok({ contacts: contacts ?? [], leads: [] }, { requestId });
}
