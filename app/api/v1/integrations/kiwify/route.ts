import { randomBytes, randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { kiwifyConfigSchema, readKiwifyBody } from "@/lib/webhooks/kiwify";

/** Configuração operacional e últimos recebimentos, sem ciphertext/segredo. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  try {
    const admin = createAdminClient();
    const org = auth.org.orgId;
    const [sources, products, receipts] = await Promise.all([
      admin.from("kiwify_integrations").select("id,name,store_id,path_token,pipeline_id,stage_id,is_active").eq("organization_id", org),
      admin.from("kiwify_product_mappings").select("integration_id,external_product_id,product_id").eq("organization_id", org),
      admin.from("kiwify_receipts").select("id,integration_id,order_id,event_type,status,reason,lead_id,event_id,conflict_count,created_at").eq("organization_id", org).order("created_at", { ascending: false }).limit(20),
    ]);
    if (sources.error || products.error || receipts.error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    return ok({ integrations: sources.data, products: products.data, receipts: receipts.data }, { requestId });
  } catch { return fail("internal_error", "Consulta indisponível.", 503, { requestId }); }
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  try {
    const parsed = kiwifyConfigSchema.safeParse(await readKiwifyBody(req));
    if (!parsed.success) return fail("invalid_request", "Configuração inválida.", 400, { requestId });
    const admin = createAdminClient();
    const { secret, ...config } = parsed.data;
    const encrypted = await encryptWebhookSecret(admin, secret);
    if (!encrypted) return fail("encryption_unavailable", "Cifra indisponível.", 422, { requestId });
    const token = randomBytes(32).toString("hex");
    const { data, error } = await admin.rpc("fn_configure_kiwify", {
      p_organization_id: auth.org.orgId, p_config: config, p_token: token,
      p_secret_encrypted: encrypted, p_request_id: requestId,
      p_actor_user_id: auth.user.id,
    });
    if (error) return fail("invalid_request", "Verifique loja, funil, etapa e produtos da organização.", 422, { requestId });
    return ok({ integration_id: data, endpoint: `/api/v1/webhooks/kiwify/${token}` }, { status: 201, requestId });
  } catch { return fail("invalid_request", "Não foi possível configurar a integração.", 400, { requestId }); }
}
