import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
const createSchema = z.object({ pipeline_id: z.uuid() }).strict();
const updateSchema = z.object({ is_active: z.boolean().optional(), pipeline_id: z.uuid().optional() })
  .strict().refine(value => value.is_active !== undefined || value.pipeline_id !== undefined);

async function eligiblePipeline(admin: ReturnType<typeof createAdminClient>, orgId: string, id: string) {
  const { data: pipeline } = await admin.from("crm_pipelines").select("id,name")
    .eq("organization_id", orgId).eq("id", id).eq("is_archived", false).maybeSingle();
  if (!pipeline) return null;
  const { data: stages } = await admin.from("crm_stages").select("id,name")
    .eq("organization_id", orgId).eq("pipeline_id", id)
    .eq("is_won", true).eq("is_archived", false);
  return stages?.length === 1 && stages[0]?.name === "Acesso ativado" ? pipeline : null;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: integration, error } = await admin.from("obra_access_integrations")
    .select("id,organization_id,pipeline_id,is_active,last_received_at,rejected_count,created_at")
    .eq("organization_id", orgId).maybeSingle();
  if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
  if (!integration) return ok({ integration: null, receipts: [], rejections: [],
    counts: { processed: 0, trial: 0, paid: 0, pending: 0, rejected: 0, duplicates: 0 } }, { requestId });
  const { data: receipts, error: receiptsError } = await admin.from("obra_access_receipts")
    .select("id,external_event_id,product_user_id,occurred_at,name,email,phone,plan,modality,provider,status,reason,contact_id,lead_id,duplicate_count,created_at,processed_at")
    .eq("organization_id", orgId).eq("integration_id", integration.id)
    .order("created_at", { ascending: false }).limit(50);
  const [{ data: all, error: countError }, { data: rejections, error: rejectionError }] = await Promise.all([
    admin.from("obra_access_receipts").select("status,modality,duplicate_count")
      .eq("organization_id", orgId).eq("integration_id", integration.id),
    admin.from("api_audit_log").select("created_at,metadata")
      .eq("organization_id", orgId).eq("resource_id", integration.id)
      .eq("action", "obra_access.rejected").order("created_at", { ascending: false }).limit(20),
  ]);
  if (receiptsError || countError || rejectionError) return fail("internal_error", "Histórico indisponível.", 503, { requestId });
  const counts = { processed: 0, trial: 0, paid: 0, pending: 0, rejected: integration.rejected_count,
    duplicates: 0 };
  for (const row of all ?? []) {
    if (row.status === "processed") {
      counts.processed++;
      if (row.modality === "trial") counts.trial++;
      if (row.modality === "paid") counts.paid++;
    }
    if (row.status === "pending") counts.pending++;
    counts.duplicates += row.duplicate_count;
  }
  return ok({ integration, receipts: receipts ?? [],
    rejections: (rejections ?? []).map(row => ({ created_at: row.created_at,
      reason: (row.metadata as Record<string, unknown> | null)?.reason ?? "invalid_request" })),
    counts }, { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  let body: unknown;
  try { body = await req.json(); } catch { return fail("invalid_request", "JSON inválido.", 400, { requestId }); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_request", "Selecione um funil.", 400, { requestId });
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  if (!await eligiblePipeline(admin, orgId, parsed.data.pipeline_id)) {
    return fail("invalid_request", "O funil precisa de uma única etapa ganha chamada Acesso ativado.", 422, { requestId });
  }
  const secret = randomBytes(32).toString("base64url");
  const encrypted = await encryptWebhookSecret(admin, secret);
  if (!encrypted) return fail("encryption_unavailable", "Cifra indisponível.", 422, { requestId });
  const { data, error } = await admin.from("obra_access_integrations")
    .insert({ organization_id: orgId, pipeline_id: parsed.data.pipeline_id,
      secret_encrypted: encrypted, is_active: false })
    .select("id,pipeline_id,is_active").single();
  if (error?.code === "23505") return fail("idempotency_conflict", "Integração já configurada.", 409, { requestId });
  if (error || !data) return fail("internal_error", "Não foi possível criar a integração.", 503, { requestId });
  await audit({ action: "obra_access.configured", actorUserId: auth.user.id,
    organizationId: orgId, resourceType: "obra_access_integration", resourceId: data.id, requestId,
    metadata: { pipeline_id: parsed.data.pipeline_id } });
  // Única exibição do segredo. GET e PATCH nunca o devolvem.
  return ok({ integration: data, endpoint: `/api/v1/webhooks/obra-no-bolso/${data.id}`,
    signing_secret: secret }, { status: 201, requestId });
}

export async function PATCH(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  let body: unknown;
  try { body = await req.json(); } catch { return fail("invalid_request", "JSON inválido.", 400, { requestId }); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_request", "Estado inválido.", 400, { requestId });
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: current } = await admin.from("obra_access_integrations")
    .select("id,pipeline_id,is_active").eq("organization_id", orgId).maybeSingle();
  if (!current) return fail("not_found", "Integração não configurada.", 404, { requestId });
  const nextPipeline = parsed.data.pipeline_id ?? current.pipeline_id;
  const nextActive = parsed.data.is_active ?? current.is_active;
  if (nextPipeline !== current.pipeline_id) {
    if (current.is_active || nextActive) return fail("invalid_request", "Desative a conexão antes de trocar o funil.", 422, { requestId });
    const { count, error: countError } = await admin.from("obra_access_receipts")
      .select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("integration_id", current.id);
    if (countError) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    if (count) return fail("invalid_request", "O funil não pode mudar após receber eventos.", 422, { requestId });
  }
  if ((nextActive || nextPipeline !== current.pipeline_id) && !await eligiblePipeline(admin, orgId, nextPipeline)) {
    return fail("invalid_request", "O funil precisa da etapa ganha Acesso ativado.", 422, { requestId });
  }
  const { error } = await admin.from("obra_access_integrations")
    .update({ is_active: nextActive, pipeline_id: nextPipeline, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId).eq("id", current.id);
  if (error) return fail("internal_error", "Não foi possível alterar o estado.", 503, { requestId });
  await audit({ action: nextActive !== current.is_active ? nextActive ? "obra_access.enabled" : "obra_access.disabled" : "obra_access.configured",
    actorUserId: auth.user.id, organizationId: orgId,
    resourceType: "obra_access_integration", resourceId: current.id, requestId,
    metadata: { pipeline_id: nextPipeline } });
  return ok({ id: current.id, is_active: nextActive, pipeline_id: nextPipeline }, { requestId });
}
