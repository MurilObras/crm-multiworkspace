import { z } from "zod";
import type { WahaPayload } from "./envelope";
import { bareWaMessageId } from "./message-id";

/** Contrato público: https://waha.devlike.pro/docs/how-to/receive-messages/#replyto */
export function responsibleQuotedId(p: WahaPayload): string | null {
  const reply = z.object({ id: z.string().min(1).max(512) }).safeParse(p.replyTo);
  return reply.success ? bareWaMessageId(reply.data.id) : null;
}
