import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  confirmVideoDelivery,
  VideoConfirmationConflict,
} from "@/lib/messaging/confirm-video-delivery";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ok, fail } from "@/lib/api/wrappers";

type Ctx = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
const inputSchema = z
  .object({ echo_id: z.string().uuid(), confirmed_same_video: z.literal(true) })
  .strict();

export async function GET(_req: NextRequest, ctx: Ctx) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "messages" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Mensagem inválida.", 400, { requestId });
  const db = await createClient();
  const { data: message, error } = await db
    .from("messages")
    .select("id,conversation_id,channel_session_id,contact_id,created_at")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível consultar a mensagem.", 500, { requestId });
  if (!message) return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
  const until = new Date(new Date(message.created_at).getTime() + 300_000).toISOString();
  const { data, error: echoesError } = await db
    .from("messages")
    .select("*")
    .eq("organization_id", auth.org.orgId)
    .eq("conversation_id", message.conversation_id)
    .eq("channel_session_id", message.channel_session_id)
    .eq("contact_id", message.contact_id)
    .eq("direction", "outbound")
    .eq("type", "video")
    .eq("sent_via", "external_device")
    .in("status", ["sent", "delivered", "read"])
    .not("external_id", "is", null)
    .is("revoked_at", null)
    .gte("sent_at", message.created_at)
    .lte("sent_at", until)
    .order("sent_at", { ascending: true })
    .limit(20);
  if (echoesError)
    return fail("internal_error", "Não foi possível consultar as entregas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "messages" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Mensagem inválida.", 400, { requestId });
  const raw = await req.json().catch(() => null);
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success)
    return fail(
      "validation_failed",
      "Confira o vídeo recebido e confirme que é o mesmo arquivo.",
      422,
      { requestId },
    );
  try {
    const result = await confirmVideoDelivery(
      getRequestPool(),
      auth.org.orgId,
      id,
      parsed.data.echo_id,
    );
    if (!result.replay)
      await audit({
        action: "message.delivery_confirmed",
        organizationId: auth.org.orgId,
        actorUserId: auth.user.id,
        resourceType: "message",
        resourceId: id,
        requestId,
        metadata: { echo_id: parsed.data.echo_id, confirmation: "human_verified" },
      });
    return ok(result, { requestId });
  } catch (err) {
    if (err instanceof VideoConfirmationConflict)
      return fail(
        "conflict",
        "A entrega mudou ou não pode ser confirmada. Atualize o histórico.",
        409,
        { requestId },
      );
    logger.warn("message_delivery_confirmation_failed", {
      requestId,
      organizationId: auth.org.orgId,
      messageId: id,
    });
    return fail("internal_error", "Não foi possível confirmar a entrega.", 500, { requestId });
  }
}
