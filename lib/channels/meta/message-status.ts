import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaWebhookSession } from "./session";
import type { MessageStatusEvent } from "./webhook";

/** Vocabulário de messages (lib/types/messaging); failed é um desfecho terminal,
 * não um ACK entre sent e delivered. Entrega/leitura comprovadas não viram falha. */
const PREVIOUS = {
  sent: ["queued", "sending"],
  delivered: ["queued", "sending", "sent"],
  read: ["queued", "sending", "sent", "delivered"],
  failed: ["queued", "sending", "sent"],
} as const;

/** Updates condicionais: a guarda roda no banco, não num SELECT sujeito a corrida.
 * Token autenticado fornece organização E sessão; nenhum tenant vem do payload.
 * Repetição não regrava status/erro. Recibos atrasados podem completar timestamps
 * sem rebaixar status, guardando o primeiro instante conhecido de cada recibo. */
export async function applyMetaMessageStatus(
  db: SupabaseClient,
  session: MetaWebhookSession,
  event: MessageStatusEvent,
  now = new Date().toISOString(),
): Promise<"processed" | "pending_correlation" | "ignored_status" | "ignored_waba"> {
  if (session.wabaId && event.wabaId !== session.wabaId) return "ignored_waba";
  const status = event.status;
  if (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed") {
    return "ignored_status";
  }

  // Zero linhas no UPDATE pode ser duplicata/recibo atrasado OU ausência de
  // correlação: o sink grava external_id só depois do retorno do transporte.
  // Distingue os dois antes de confirmar o webhook. Se o ID aparecer logo após
  // esta leitura, um 503 conservador só provoca uma reentrega idempotente.
  const { data: message, error: lookupError } = await db.from("messages")
    .select("id")
    .eq("organization_id", session.organizationId)
    .eq("channel_session_id", session.id)
    .eq("external_id", event.externalId)
    .eq("direction", "outbound")
    .maybeSingle();
  if (lookupError) throw new Error(`meta_message_status_lookup: ${lookupError.message}`);
  if (!message) return "pending_correlation";

  const scopedUpdate = (patch: Record<string, unknown>) => db.from("messages")
    .update(patch)
    .eq("organization_id", session.organizationId)
    .eq("channel_session_id", session.id)
    .eq("external_id", event.externalId)
    .eq("direction", "outbound");

  const { error } = await scopedUpdate({
    status,
    error_code: status === "failed" && event.errorCode !== null ? String(event.errorCode) : null,
    error_message: status === "failed" ? event.errorMessage : null,
  }).in("status", [...PREVIOUS[status]]);
  if (error) throw new Error(`meta_message_status_update: ${error.message}`);

  if (status !== "failed") {
    const column = status === "sent" ? "sent_at" : status === "delivered" ? "delivered_at" : "read_at";
    const at = event.occurredAt ?? now;
    // sent_at já nasce no outbound: sem timestamp do evento, preserve esse valor.
    if (status === "sent" && event.occurredAt === null) return "processed";
    const eligible = status === "sent" ? ["sent", "delivered", "read"]
      : status === "delivered" ? ["delivered", "read"] : ["read"];
    const query = scopedUpdate({ [column]: at }).in("status", eligible);
    // O sent_at inicial é o instante da intenção no sink, não o recibo da Meta.
    const { error: timestampError } = await (status === "sent"
      ? query.neq(column, at)
      : query.or(`${column}.is.null,${column}.gt.${at}`));
    if (timestampError) throw new Error(`meta_message_status_timestamp: ${timestampError.message}`);
  }
  return "processed";
}
