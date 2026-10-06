import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { processObraAccessReceipt } from "@/lib/obra-no-bolso/process-receipt";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(_req: Request, context: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return fail("invalid_request", "Recibo inválido.", 400, { requestId });
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: receipt } = await admin.from("obra_access_receipts")
    .select("integration_id,status").eq("organization_id", orgId).eq("id", id).maybeSingle();
  if (!receipt || !["ready", "processing"].includes(receipt.status)) {
    return fail("not_found", "Recibo não retomável.", 404, { requestId });
  }
  try {
    return ok(await processObraAccessReceipt(admin, orgId, receipt.integration_id, id), { requestId });
  } catch {
    return fail("internal_error", "Conversão ainda não confirmada; tente novamente.", 503, { requestId });
  }
}
