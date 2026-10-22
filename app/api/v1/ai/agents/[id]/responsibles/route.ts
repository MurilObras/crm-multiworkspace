import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { consultationSettingsSchema, responsibleSchema } from "@/lib/responsibles/config";
import { readResponsibleSettings, saveResponsible, saveResponsibleSettings } from "@/lib/responsibles/service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, context: Context) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agent_responsibles" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", "Agente inválido.", 400, { requestId });
  try {
    const data = await readResponsibleSettings(getRequestPool(), auth.org.orgId, id);
    return data ? ok(data, { requestId }) : fail("not_found", "Agente não encontrado.", 404, { requestId });
  } catch { return fail("unavailable", "Não foi possível carregar os responsáveis.", 503, { requestId }); }
}

export async function PUT(req: Request, context: Context) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "agent_responsibles" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", "Agente inválido.", 400, { requestId });
  let input: unknown;
  try { input = await req.json(); } catch { return fail("invalid_request", "Conteúdo inválido.", 400, { requestId }); }
  const parsed = consultationSettingsSchema.safeParse(input);
  if (!parsed.success) return fail("validation_failed", parsed.error.issues[0]?.message ?? "Configuração inválida.", 422, { requestId });
  try {
    await saveResponsibleSettings(getRequestPool(), auth.org.orgId, id, parsed.data);
    await audit({ action: "ai.responsible_settings_updated", organizationId: auth.org.orgId, actorUserId: auth.user.id,
      resourceType: "ai_agent", resourceId: id, requestId, metadata: { enabled: parsed.data.enabled, recipient_count: parsed.data.recipient_ids.length } });
    return ok({ saved: true }, { requestId });
  } catch (e) {
    const known = e instanceof Error ? e.message : "";
    if (known === "agent_not_found") return fail("not_found", "Agente não encontrado.", 404, { requestId });
    if (known === "responsible_channel_unavailable") return fail("validation_failed", "Vincule este agente a uma conexão de WhatsApp por QR Code antes de ativar a consulta.", 422, { requestId });
    if (known === "recipient_unavailable") return fail("validation_failed", "Selecione responsáveis ativos deste workspace.", 422, { requestId });
    if (known === "recipient_is_channel") return fail("validation_failed", "O responsável precisa usar um número diferente das conexões do workspace.", 422, { requestId });
    if (known === "settings_have_pending_requests") return fail("validation_failed", "Resolva os pedidos pendentes antes de desativar a consulta ou trocar os destinatários.", 422, { requestId });
    return fail("unavailable", "Não foi possível salvar a consulta ao responsável.", 503, { requestId });
  }
}

const editSchema = responsibleSchema.extend({ id: z.string().uuid().optional() });
export async function POST(req: Request, context: Context) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "agent_responsibles" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", "Agente inválido.", 400, { requestId });
  let input: unknown;
  try { input = await req.json(); } catch { return fail("invalid_request", "Conteúdo inválido.", 400, { requestId }); }
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return fail("validation_failed", parsed.error.issues[0]?.message ?? "Responsável inválido.", 422, { requestId });
  try {
    const pool = getRequestPool();
    const agent = await pool.query("select id from ai_agents where organization_id=$1 and id=$2 and archived_at is null", [auth.org.orgId, id]);
    if (!agent.rows.length) return fail("not_found", "Agente não encontrado.", 404, { requestId });
    const { id: responsibleId, ...value } = parsed.data;
    const responsible = await saveResponsible(pool, auth.org.orgId, value, responsibleId);
    if (!responsible) return fail("not_found", "Responsável não encontrado.", 404, { requestId });
    await audit({ action: "ai.responsible_saved", organizationId: auth.org.orgId, actorUserId: auth.user.id,
      resourceType: "agent_responsible", resourceId: responsible.id, requestId, metadata: { enabled: responsible.enabled } });
    return ok(responsible, { requestId });
  } catch (e) {
    if (e instanceof Error && e.message === "recipient_is_channel") return fail("validation_failed", "O responsável precisa usar um número diferente das conexões do workspace.", 422, { requestId });
    if (e instanceof Error && e.message === "recipient_still_assigned") return fail("validation_failed", "Desmarque este responsável nos agentes ativos antes de desativá-lo.", 422, { requestId });
    if (e instanceof Error && e.message === "recipient_has_pending_requests") return fail("validation_failed", "Resolva os pedidos pendentes antes de mudar o número ou desativar este responsável.", 422, { requestId });
    if (typeof e === "object" && e !== null && "code" in e && e.code === "23505") return fail("validation_failed", "Esse número já está cadastrado neste workspace.", 422, { requestId });
    return fail("unavailable", "Não foi possível salvar o responsável.", 503, { requestId });
  }
}
