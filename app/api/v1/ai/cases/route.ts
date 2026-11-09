/**
 * GET /api/v1/ai/cases — lista os casos humanos da org (spec 15 §7, Wave 5).
 * Read-only via PostgREST (`createAdminClient`) — a escrita de estado do caso
 * mora em POST /api/v1/ai/cases/[id]/reply (pg.Pool do engine, ver ADR ali).
 *
 * A consulta em si vive em `lib/escalacao/chamados.ts`: a capacidade "ver os
 * chamados em aberto" do agente lê exatamente a mesma lista, e a tela e o agente
 * discordarem sobre o que está aberto seria o pior tipo de divergência.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listarChamados } from "@/lib/escalacao/chamados";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
  conversation_id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
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

  try {
    const db = createAdminClient();
    const { chamados, abertos } = await listarChamados(db, org.orgId, {
      estado: parsed.data.status === "open" ? "abertos" : "fechados",
      ...(parsed.data.conversation_id ? { conversationId: parsed.data.conversation_id, limite: 50 } : {}),
    });
    let agentName: string | null = null;
    if (parsed.data.conversation_id && chamados[0]?.agent_id) {
      const { data: agent, error } = await db.from("ai_agents").select("name")
        .eq("organization_id", org.orgId).eq("id", chamados[0].agent_id).maybeSingle();
      if (error) throw error;
      agentName = agent?.name ?? null;
    }
    let resolutionMessageIds: string[] = [];
    if (parsed.data.conversation_id) {
      const { data: resolutions, error } = await db.from("case_resolution_intents").select("message_id")
        .eq("organization_id", org.orgId).eq("conversation_id", parsed.data.conversation_id)
        .order("created_at", { ascending: false }).limit(5);
      if (error) throw error;
      resolutionMessageIds = (resolutions ?? []).map(row => row.message_id as string);
    }
    return ok({ cases: chamados, open_count: abertos, agent_name: agentName, resolution_message_ids: resolutionMessageIds }, { requestId });
  } catch {
    return fail("internal_error", "Falha ao carregar os casos.", 500, { requestId });
  }
}
