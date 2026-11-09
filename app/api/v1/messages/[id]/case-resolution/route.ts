import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { readCaseResolution } from "@/lib/escalacao/resolucao-vinculada";

export const dynamic = "force-dynamic";

/** O progresso é lido do registro durável, nunca inferido da bolha ou do HTTP. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("validation_failed", "Mensagem inválida.", 422, { requestId });
  const db = await createClient();
  const { data: message, error } = await db.from("messages").select("id")
    .eq("organization_id", auth.org.orgId).eq("id", id).maybeSingle();
  if (error) return fail("unavailable", "Não foi possível consultar a mensagem.", 503, { requestId });
  if (!message) return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
  try {
    return ok(await readCaseResolution(getRequestPool(), auth.org.orgId, id), { requestId });
  } catch {
    return fail("unavailable", "Não foi possível conferir a resolução da consulta. Recarregue o caso.", 503, { requestId });
  }
}
