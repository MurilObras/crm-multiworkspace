import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkObraAccessRate } from "@/lib/obra-no-bolso/rate-limit";
import { refreshSubscriptionState } from "@/lib/obra-no-bolso/subscription-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", "Estado não encontrado.", 404, { requestId });
  try {
    if (!await checkObraAccessRate(`refresh:${auth.org.orgId}`)) {
      return fail("rate_limited", "Aguarde antes de consultar novamente.", 429, { requestId });
    }
    const result = await refreshSubscriptionState(createAdminClient(), auth.org.orgId, id);
    await audit({ action: "obra_subscription.refreshed", actorUserId: auth.user.id,
      organizationId: auth.org.orgId, resourceType: "obra_subscription_state", resourceId: id,
      requestId, metadata: { decision: result.decision } });
    return ok(result, { requestId });
  } catch {
    return fail("internal_error", "Não foi possível confirmar o estado no aplicativo. Nenhuma mensagem foi autorizada.", 503, { requestId });
  }
}
