import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { audit } from "@/lib/audit";
import { DEFAULT_ACTIVATION_MESSAGE, DEFAULT_REGISTRATION_MESSAGE, DEFAULT_USAGE_MESSAGE } from "@/lib/obra-no-bolso/messages";

export const dynamic = "force-dynamic";
const createSchema = z.object({ pipeline_id: z.uuid(), lifecycle_enabled: z.boolean().default(false) }).strict();
const outreachSchema = z.object({ enabled: z.boolean(), channel_session_id: z.uuid().nullable(), recovery_pointer_id: z.uuid().nullable(),
  registration_message: z.string().max(2000), usage_message: z.string().max(2000), activation_message: z.string().max(2000) }).strict();
const updateSchema = z.object({ is_active: z.boolean().optional(), pipeline_id: z.uuid().optional(), lifecycle_enabled: z.boolean().optional(), outreach: outreachSchema.optional() })
  .strict().refine(value => Object.values(value).some(field => field !== undefined));

async function eligiblePipeline(admin: ReturnType<typeof createAdminClient>, orgId: string, id: string) {
  const { data: pipeline } = await admin.from("crm_pipelines").select("id,name")
    .eq("organization_id", orgId).eq("id", id).eq("is_archived", false).maybeSingle();
  if (!pipeline) return null;
  const { data: stages } = await admin.from("crm_stages").select("id,name")
    .eq("organization_id", orgId).eq("pipeline_id", id)
    .eq("is_won", true).eq("is_archived", false);
  return stages?.length === 1 && stages[0]?.name === "Acesso ativado" ? pipeline : null;
}

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "webhook_sources" });
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const history = z.object({ status: z.enum(["all", "pending", "ready"]), offset: z.coerce.number().int().min(0).max(1_000_000) })
    .safeParse({ status: params.get("status") ?? "all", offset: params.get("offset") ?? 0 });
  if (!history.success) return fail("invalid_request", "Filtro de histórico inválido.", 400, { requestId });
  const { offset, status } = history.data;
  const admin = createAdminClient();
  const orgId = auth.org.orgId;
  const { data: integration, error } = await admin.from("obra_access_integrations")
    .select("id,organization_id,pipeline_id,is_active,lifecycle_enabled,last_received_at,rejected_count,created_at,outreach_enabled,outreach_channel_id,recovery_pointer_id,registration_rule_id,usage_rule_id,activation_rule_id")
    .eq("organization_id", orgId).maybeSingle();
  if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
  if (!integration) return ok({ integration: null, receipts: [], rejections: [],
    counts: { processed: 0, trial: 0, paid: 0, pending: 0, rejected: 0, duplicates: 0 },
    pagination: { offset, has_more: false } }, { requestId });
  let historyQuery = admin.from("obra_access_receipts")
    .select("id,external_event_id,product_user_id,occurred_at,name,email,phone,plan,modality,provider,status,reason,contact_id,lead_id,duplicate_count,created_at,processed_at")
    .eq("organization_id", orgId).eq("integration_id", integration.id)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 50);
  if (status !== "all") historyQuery = historyQuery.eq("status", status);
  const { data: receipts, error: receiptsError } = await historyQuery;
  const [{ data: counts, error: countError }, { data: rejections, error: rejectionError }] = await Promise.all([
    admin.rpc("fn_obra_access_counts", { p_organization_id: orgId, p_integration_id: integration.id }),
    admin.from("api_audit_log").select("created_at,metadata")
      .eq("organization_id", orgId).eq("resource_id", integration.id)
      .eq("action", "obra_access.rejected").order("created_at", { ascending: false }).limit(20),
  ]);
  if (receiptsError || countError || rejectionError) return fail("internal_error", "Histórico indisponível.", 503, { requestId });
  const { data: subscriptions, error: subscriptionsError } = await admin.from("obra_subscription_states")
    .select("id,product_user_id,contact_id,lead_id,trial_started_at,checked_at,status_pagamento,em_trial,decision,reason,converted_at,contact:contacts(name),lead:crm_leads(title)")
    .eq("organization_id", orgId).eq("integration_id", integration.id)
    .order("updated_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 50);
  if (subscriptionsError) return fail("internal_error", "Acompanhamento indisponível.", 503, { requestId });
  const ruleIds = [integration.registration_rule_id,integration.usage_rule_id,integration.activation_rule_id].filter(Boolean);
  const { data: messages, error: messagesError } = ruleIds.length ? await admin.from("automation_rules")
    .select("id,actions").eq("organization_id", orgId).in("id",ruleIds) : { data: [], error: null };
  if (messagesError) return fail("internal_error", "Mensagens indisponíveis.", 503, { requestId });
  const template = (id: string | null, fallback: string) => !id ? fallback
    : (messages ?? []).find(row => row.id === id)?.actions?.[0]?.config?.template ?? "";
  return ok({ integration, outreach: { enabled: integration.outreach_enabled ?? false,
    channel_session_id: integration.outreach_channel_id ?? null, recovery_pointer_id: integration.recovery_pointer_id ?? null,
    registration_message: template(integration.registration_rule_id, DEFAULT_REGISTRATION_MESSAGE),
    usage_message: template(integration.usage_rule_id, DEFAULT_USAGE_MESSAGE),
    activation_message: template(integration.activation_rule_id, DEFAULT_ACTIVATION_MESSAGE) }, subscriptions: (subscriptions ?? []).slice(0, 50),
    subscription_pagination: { offset, has_more: (subscriptions?.length ?? 0) > 50 }, receipts: (receipts ?? []).slice(0, 50),
    rejections: (rejections ?? []).map(row => ({ created_at: row.created_at,
      reason: (row.metadata as Record<string, unknown> | null)?.reason ?? "invalid_request" })),
    counts, pagination: { offset, has_more: (receipts?.length ?? 0) > 50 } }, { requestId });
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
      secret_encrypted: encrypted, is_active: false, lifecycle_enabled: parsed.data.lifecycle_enabled })
    .select("id,pipeline_id,is_active").single();
  if (error?.code === "23505") return fail("idempotency_conflict", "Integração já configurada.", 409, { requestId });
  if (error || !data) return fail("internal_error", "Não foi possível criar a integração.", 503, { requestId });
  await audit({ action: "obra_access.configured", actorUserId: auth.user.id,
    organizationId: orgId, resourceType: "obra_access_integration", resourceId: data.id, requestId,
    metadata: { pipeline_id: parsed.data.pipeline_id, lifecycle_enabled: parsed.data.lifecycle_enabled } });
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
    .select("id,pipeline_id,is_active,lifecycle_enabled").eq("organization_id", orgId).maybeSingle();
  if (!current) return fail("not_found", "Integração não configurada.", 404, { requestId });
  if (parsed.data.outreach) {
    if (Object.keys(parsed.data).length !== 1 || !current.lifecycle_enabled) {
      return fail("invalid_request", "Salve as mensagens separadamente no modo teste e assinatura.", 422, { requestId });
    }
    const cfg = parsed.data.outreach;
    const { data, error: configError } = await admin.rpc("fn_configure_obra_outreach", {
      p_org: orgId, p_integration: current.id, p_enabled: cfg.enabled, p_channel: cfg.channel_session_id,
      p_recovery: cfg.recovery_pointer_id, p_registration: cfg.registration_message, p_usage: cfg.usage_message,
      p_activation: cfg.activation_message,
    });
    if (configError || !data) return fail("invalid_request", "Confira o número conectado por QR code e o fluxo de recuperação deste workspace.", 422, { requestId });
    await audit({ action: "obra_subscription.outreach_configured", actorUserId: auth.user.id, organizationId: orgId,
      resourceType: "obra_access_integration", resourceId: current.id, requestId, metadata: { outreach_enabled: cfg.enabled } });
    return ok(data, { requestId });
  }
  const nextPipeline = parsed.data.pipeline_id ?? current.pipeline_id;
  const nextActive = parsed.data.is_active ?? current.is_active;
  const nextLifecycle = parsed.data.lifecycle_enabled ?? current.lifecycle_enabled;
  if (nextLifecycle !== current.lifecycle_enabled) {
    if (current.is_active || nextActive) return fail("invalid_request", "Desative a conexão antes de trocar o modo.", 422, { requestId });
    const { count: previous, error: previousError } = await admin.from("obra_access_receipts")
      .select("id", { head: true, count: "exact" }).eq("organization_id", orgId).eq("integration_id", current.id);
    const { count: states, error: statesError } = await admin.from("obra_subscription_states")
      .select("id", { head: true, count: "exact" }).eq("organization_id", orgId).eq("integration_id", current.id);
    if (previousError || statesError) return fail("internal_error", "Histórico indisponível.", 503, { requestId });
    if (previous || states) return fail("invalid_request", "O modo não pode mudar depois de receber eventos.", 422, { requestId });
  }
  if (nextPipeline !== current.pipeline_id) {
    if (current.is_active || nextActive) return fail("invalid_request", "Desative a conexão antes de trocar o funil.", 422, { requestId });
    const { count, error: countError } = await admin.from("obra_access_receipts")
      .select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("integration_id", current.id);
    const { count: states, error: statesError } = await admin.from("obra_subscription_states")
      .select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("integration_id", current.id);
    if (countError || statesError) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    if (count || states) return fail("invalid_request", "O funil não pode mudar após receber eventos.", 422, { requestId });
  }
  if ((nextActive || nextPipeline !== current.pipeline_id) && !await eligiblePipeline(admin, orgId, nextPipeline)) {
    return fail("invalid_request", "O funil precisa da etapa ganha Acesso ativado.", 422, { requestId });
  }
  const { error } = await admin.from("obra_access_integrations")
    .update({ is_active: nextActive, pipeline_id: nextPipeline, lifecycle_enabled: nextLifecycle, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId).eq("id", current.id);
  if (error) return fail("internal_error", "Não foi possível alterar o estado.", 503, { requestId });
  await audit({ action: nextActive !== current.is_active ? nextActive ? "obra_access.enabled" : "obra_access.disabled" : "obra_access.configured",
    actorUserId: auth.user.id, organizationId: orgId,
    resourceType: "obra_access_integration", resourceId: current.id, requestId,
    metadata: { pipeline_id: nextPipeline, lifecycle_enabled: nextLifecycle } });
  return ok({ id: current.id, is_active: nextActive, pipeline_id: nextPipeline, lifecycle_enabled: nextLifecycle }, { requestId });
}
