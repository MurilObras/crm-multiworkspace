import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { kiwifyUpdateSchema, readKiwifyBody } from "@/lib/webhooks/kiwify";
import { kiwifyManagementError } from "@/lib/webhooks/kiwify-management";

type Context = { params: Promise<{ id: string }> };
async function manage(req: Request, context: Context, operation: "edit" | "archive") {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return fail("invalid_request", "Identificador inválido.", 400, { requestId });
  try {
    const admin = createAdminClient();
    let config = {};
    let encrypted: string | null = null;
    if (operation === "edit") {
      const parsed = kiwifyUpdateSchema.safeParse(await readKiwifyBody(req));
      if (!parsed.success) return fail("invalid_request", "Verifique nome, Store ID, funil, etapa e mapeamentos.", 400, { requestId });
      const { secret, ...fields } = parsed.data;
      config = fields;
      if (secret) {
        encrypted = await encryptWebhookSecret(admin, secret);
        if (!encrypted) return fail("encryption_unavailable", "Cifra indisponível.", 422, { requestId });
      }
    }
    const { error } = await admin.rpc("fn_manage_kiwify", {
      p_organization_id: auth.org.orgId, p_integration_id: id, p_operation: operation,
      p_config: config, p_secret_encrypted: encrypted, p_actor_user_id: auth.user.id, p_request_id: requestId,
    });
    if (error) return kiwifyManagementError(error, requestId);
    return ok({ integration_id: id }, { requestId });
  } catch { return fail("invalid_request", "Não foi possível processar a integração.", 400, { requestId }); }
}
export async function PATCH(req: Request, context: Context) { return manage(req, context, "edit"); }
export async function DELETE(req: Request, context: Context) { return manage(req, context, "archive"); }
