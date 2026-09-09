import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { campaignCreateSchema, campaignFiltersSchema, recipientStatuses } from "@/lib/campaigns/schema";
import { contactAudienceQuery } from "@/app/api/v1/contacts/_handler";
import { normalizaTelefone } from "@/lib/contacts/csv";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const org = auth.org.orgId;
  const url = new URL(req.url);
  if (url.searchParams.has("preview")) {
    const parsed = campaignFiltersSchema.safeParse({ tag: url.searchParams.get("tag"),
      source: url.searchParams.get("source") ?? undefined });
    if (!parsed.success) return fail("validation_failed", "Informe uma tag valida.", 422, { requestId });
    const { count, error } = await contactAudienceQuery(admin, org, parsed.data);
    if (error) return fail("internal_error", "Falha ao calcular publico.", 500, { requestId });
    return ok({ count: count ?? 0 }, { requestId });
  }
  const id = url.searchParams.get("id");
  if (id) {
    if (!z.uuid().safeParse(id).success) return fail("validation_failed", "ID invalido.", 422, { requestId });
    const page = z.coerce.number().int().min(0).max(1000000).safeParse(url.searchParams.get("page") ?? 0);
    if (!page.success) return fail("validation_failed", "Pagina invalida.", 422, { requestId });
    const { data: campaign, error } = await admin.from("whatsapp_campaigns").select("*")
      .eq("organization_id", org).eq("id", id).maybeSingle();
    if (error) return fail("internal_error", "Falha ao ler campanha.", 500, { requestId });
    if (!campaign) return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
    const counts: Record<string, number> = {};
    for (const status of recipientStatuses) {
      const { count, error: countError } = await admin.from("whatsapp_campaign_recipient_steps")
        .select("id", { count: "exact", head: true }).eq("organization_id", org).eq("campaign_id", id).eq("status", status);
      if (countError) return fail("internal_error", "Falha ao contar destinatarios.", 500, { requestId });
      counts[status] = count ?? 0;
    }
    const { data: recipients, error: recipientsError } = await admin.from("whatsapp_campaign_recipients")
      .select("id, contact_id").eq("organization_id", org).eq("campaign_id", id).order("id").range(page.data * 100, page.data * 100 + 100);
    if (recipientsError) return fail("internal_error", "Falha ao ler destinatarios.", 500, { requestId });
    const contactIds = (recipients ?? []).map((r) => r.contact_id);
    let stepRows: Array<{ contact_id: string; step_index: number; status: string; message_id: string | null; failure_reason: string | null }> = [];
    if (contactIds.length) {
      const { data: steps, error: stepsError } = await admin.from("whatsapp_campaign_recipient_steps")
        .select("contact_id, step_index, status, message_id, failure_reason")
        .eq("organization_id", org).eq("campaign_id", id).in("contact_id", contactIds).order("step_index");
      if (stepsError) return fail("internal_error", "Falha ao ler progresso dos passos.", 500, { requestId });
      stepRows = steps ?? [];
    }
    const byContact = new Map<string, Array<{ step_index: number; status: string; message_id: string | null; failure_reason: string | null }>>();
    for (const s of stepRows) {
      const list = byContact.get(s.contact_id) ?? [];
      list.push(s);
      byContact.set(s.contact_id, list);
    }
    return ok({
      campaign,
      counts,
      recipients: (recipients ?? []).slice(0, 100).map((r) => ({ id: r.id, contact_id: r.contact_id, steps: byContact.get(r.contact_id) ?? [] })),
      has_more: (recipients?.length ?? 0) > 100,
    }, { requestId });
  }
  const [{ data: campaigns, error }, { data: channels, error: channelsError }] = await Promise.all([
    admin.from("whatsapp_campaigns").select("*").eq("organization_id", org).order("created_at", { ascending: false }).limit(100),
    admin.from("channel_sessions").select("id, phone_number, status").eq("organization_id", org)
      .is("archived_at", null).eq("status", "WORKING").order("created_at"),
  ]);
  if (error || channelsError) return fail("internal_error", "Falha ao carregar campanhas.", 500, { requestId });
  return ok({ campaigns, channels }, { requestId });
}

export async function POST(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "contacts" });
  if (!auth.ok) return auth.response;
  const parsed = campaignCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Confira os campos da campanha.", 422, { requestId });
  const p = parsed.data;
  const audience = p.audience?.map((c) => ({ ...c, phone_number: normalizaTelefone(c.phone_number) }));
  if (audience?.some((c) => !c.phone_number)) return fail("validation_failed", "Telefone invalido.", 422, { requestId });
  const extended = p.audience !== undefined || p.scheduled_at !== undefined;
  const { data: campaignId, error } = await createAdminClient().rpc(extended ? "prepare_whatsapp_campaign" : "launch_whatsapp_campaign", {
    p_id: p.id, p_organization_id: auth.org.orgId, p_created_by: auth.user.id,
    p_name: p.name, p_channel_session_id: p.channel_session_id, p_steps: p.steps,
    p_filters: p.filters ?? {}, p_hourly_limit: p.hourly_limit,
    ...(extended ? { p_audience: audience ?? null, p_scheduled_at: p.scheduled_at ?? null } : {}),
  });
  if (error) {
    const isValidation = error.code === "22023";
    return fail(isValidation ? "validation_failed" : "internal_error",
      isValidation ? "Confira o canal, o publico e a data futura do agendamento." : "Falha ao iniciar. Repita com o mesmo identificador.",
      isValidation ? 422 : 500, { requestId });
  }
  await audit({ action: "whatsapp_campaign.launched", organizationId: auth.org.orgId,
    actorUserId: auth.user.id, resourceType: "whatsapp_campaign", resourceId: campaignId, requestId });
  return ok({ id: campaignId }, { status: 201, requestId });
}
