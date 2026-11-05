import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { reprocessMedia } from "@/lib/messaging/media/reprocess";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "messages" });
  if (!auth.ok) return auth.response;
  const parsed = z.string().uuid().safeParse((await params).id);
  if (!parsed.success) return fail("validation_failed", "Mensagem inválida.", 422, { requestId });
  // Sessão/RLS antes do pool privilegiado: um agente não lê outra carteira.
  const session = await createClient();
  const { data, error } = await session.from("messages").select("id")
    .eq("organization_id", auth.org.orgId).eq("id", parsed.data).maybeSingle();
  if (error) return fail("unavailable", "Não foi possível conferir o acesso. Tente novamente.", 503, { requestId });
  if (!data) return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
  try {
    const result = await reprocessMedia(getRequestPool(), auth.org.orgId, parsed.data);
    if (result !== "queued") return fail("invalid_state", result === "busy"
      ? "A mídia já está sendo processada. Aguarde a conclusão."
      : "Só é possível reprocessar mídia recebida, armazenada e com falha de leitura.", 409, { requestId });
    await audit({ action: "message.media_reprocess_requested", actorUserId: auth.user.id,
      organizationId: auth.org.orgId, resourceType: "message", resourceId: data.id, requestId });
    return ok({ status: "pending" }, { requestId });
  } catch {
    logger.error("media_reprocess_failed", { request_id: requestId });
    return fail("unavailable", "Não foi possível iniciar o processamento. Tente novamente.", 503, { requestId });
  }
}
