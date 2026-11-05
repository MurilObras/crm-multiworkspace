/**
 * Épico Operação Visível (F1) — central de avisos do agente.
 * GET → agent_inbox_items da org (default: abertos), mais recente primeiro.
 * Itens de plataforma (organization_id null) são do operador do sistema, não
 * do tenant — nunca entram aqui.
 */
import { withReadRequest } from "@/lib/supabase/read-request";
import { inboxOrigins } from "@/lib/ai/inbox-origins";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "ack", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function readHandler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { status, limit } = parsed.data;

  const admin = createAdminClient();
  let query = admin
    .from("agent_inbox_items")
    .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status !== "all") {
    query = query.eq("status", status);
  }
  const { data, error } = await query;
  if (error) {
    return fail("internal_error", "Falha ao carregar os avisos.", 500, { requestId });
  }

  const { count: openCount } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("status", "open");

  // Falha no enriquecimento não esconde alertas; não adivinha o contato.
  let origins: Awaited<ReturnType<typeof inboxOrigins>> = new Map();
  try { origins = await inboxOrigins(org.orgId, data ?? []); } catch { /* Origem indisponível aparece explicitamente na tela. */ }
  return ok({ items: (data ?? []).map(item => ({ ...item, origin: origins.get(item.id) ?? null })), open_count: openCount ?? 0 }, { requestId });
}

export const GET = withReadRequest("api/v1/ai/inbox", readHandler);
