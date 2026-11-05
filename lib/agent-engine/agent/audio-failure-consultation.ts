import { TETO_ESPERA_DERIVACAO_MS } from "@/lib/messaging/media/derivable";
import type pg from "pg";
import { MESSAGE_ORDER_DESC } from "@/lib/messaging/message-order";
import { openCase, hasOpenCaseForContact, type CaseIds } from "./human-cases";

/** Falha técnica não é fala incompreensível. Consulta antes de chamar o modelo. */
export async function consultFailedAudio(pool: pg.Pool, ids: CaseIds, inboundAnchor: string | null, now: Date = new Date()): Promise<boolean> {
  if (!inboundAnchor) return false;
  const { rows } = await pool.query<{ id: string; type: string; media_derived_status: string | null; created_at: string }>(
    `select id,type,media_derived_status,created_at::text as created_at from messages
     where organization_id=$1 and conversation_id=$2 and direction='inbound' and revoked_at is null
     order by ${MESSAGE_ORDER_DESC} limit 1`, [ids.tenantId, ids.conversationId]);
  const latest = rows[0];
  if (latest?.id !== inboundAnchor || latest.type !== "audio") return false;
  const age = now.getTime() - new Date(latest.created_at).getTime();
  const failed = latest.media_derived_status === "failed";
  const overdue = latest.media_derived_status !== "ready" && Number.isFinite(age) && age >= TETO_ESPERA_DERIVACAO_MS;
  if (!failed && !overdue) return false;
  const opened = await openCase(pool, ids, {
    title: "Áudio precisa de conferência",
    summary: failed ? "O último áudio do cliente terminou sem transcrição segura. Confira a mensagem original no atendimento antes de responder."
      : "O processamento do último áudio excedeu o prazo de espera e ainda não há transcrição segura. Confira a mensagem original antes de responder.",
    blocker: "Falha no processamento do áudio. Não afirmar que o cliente falou algo incompreensível nem inventar conteúdo.",
    contextSnapshot: { message_id: latest.id, media_derived_status: latest.media_derived_status },
    source: "guardrail_autofallback",
  });
  if (!opened.ok && !(await hasOpenCaseForContact(pool, ids.tenantId, ids.conversationId))) {
    throw new Error("audio_failure_consultation_not_opened");
  }
  return true;
}
