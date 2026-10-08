import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { processObraAccessReceipt } from "@/lib/obra-no-bolso/process-receipt";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const bodySchema = z.object({ contact_id: z.uuid(), lead_id: z.uuid() }).strict();

export async function POST(req: Request, context: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return fail("invalid_request", "Pendente inválido.", 400, { requestId });
  let input: unknown;
  try { input = await req.json(); } catch { return fail("invalid_request", "JSON inválido.", 400, { requestId }); }
  const parsed = bodySchema.safeParse(input);
  if (!parsed.success) return fail("invalid_request", "Selecione contato e oportunidade.", 400, { requestId });
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: receipt, error } = await admin.from("obra_access_receipts")
    .select("integration_id,status").eq("organization_id", orgId).eq("id", id).maybeSingle();
  if (error || !receipt || receipt.status !== "pending") {
    return fail("not_found", "Pendente não encontrado.", 404, { requestId });
  }
  const { error: linkError } = await admin.rpc("fn_manual_link_obra_access", {
    p_organization_id: orgId, p_receipt_id: id, p_contact_id: parsed.data.contact_id,
    p_lead_id: parsed.data.lead_id, p_actor_user_id: auth.user.id, p_request_id: requestId,
  });
  if (linkError) return fail("idempotency_conflict", "Associação indisponível ou já utilizada.", 409, { requestId });
  try {
    const processed = await processObraAccessReceipt(admin, orgId, receipt.integration_id, id);
    return ok(processed, { requestId });
  } catch {
    return fail("internal_error", "Associação salva; conversão ainda não confirmada. Reenvie o evento.", 503, { requestId });
  }
}
