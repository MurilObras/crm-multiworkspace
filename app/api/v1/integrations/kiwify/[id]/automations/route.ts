import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { readKiwifyBody } from "@/lib/webhooks/kiwify";
import { kiwifyManagementError } from "@/lib/webhooks/kiwify-management";
import { validateAutomationReferences } from "@/lib/automation/validate-references";

type Context = { params: Promise<{ id: string }> };
async function manage(req: Request, context: Context, operation: "link" | "unlink") {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await context.params;
    const parsed = z.object({ rule_id: z.uuid() }).strict().safeParse(await readKiwifyBody(req));
    if (!z.uuid().safeParse(id).success || !parsed.success) return fail("invalid_request", "Vínculo inválido.", 400, { requestId });
    const admin = createAdminClient();
    if (operation === "link") {
      const [rule, integration] = await Promise.all([
        admin.from("automation_rules").select("actions").eq("organization_id", auth.org.orgId).eq("id", parsed.data.rule_id).maybeSingle(),
        admin.from("kiwify_integrations").select("pipeline_id").eq("organization_id", auth.org.orgId).eq("id", id).is("archived_at", null).maybeSingle(),
      ]);
      if (rule.error || integration.error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
      if (!rule.data || !integration.data) return fail("not_found", "Integração ou automação não encontrada.", 404, { requestId });
      const reason = await validateAutomationReferences(admin, auth.org.orgId, rule.data.actions, integration.data.pipeline_id);
      if (reason) return fail("invalid_request", reason, 422, { requestId });
    }
    const { error } = await admin.rpc("fn_manage_kiwify", {
      p_organization_id: auth.org.orgId, p_integration_id: id, p_operation: operation,
      p_config: parsed.data, p_secret_encrypted: null, p_actor_user_id: auth.user.id, p_request_id: requestId,
    });
    if (error) return kiwifyManagementError(error, requestId);
    return ok({ integration_id: id, rule_id: parsed.data.rule_id, linked: operation === "link" }, { requestId });
  } catch { return fail("invalid_request", "Não foi possível alterar o vínculo.", 400, { requestId }); }
}
export async function PUT(req: Request, context: Context) { return manage(req, context, "link"); }
export async function DELETE(req: Request, context: Context) { return manage(req, context, "unlink"); }
