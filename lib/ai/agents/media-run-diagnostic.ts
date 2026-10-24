import { mediaDecisionSchema } from "@/lib/agent-engine/agent/media-intent";
import type { MediaDiagnostic } from "./media-simulation";

export interface MediaRunJob {
  id: string;
  organization_id: string;
  contact_id: string | null;
  payload: Record<string, unknown>;
}
export interface MediaRunMessage {
  id: string;
  organization_id: string;
  conversation_id: string;
  status: string;
  external_id: string | null;
  error_code: string | null;
  metadata: Record<string, unknown> | null;
}

/** Associação por job_id real, nunca por horário ou último contato do agente. */
export function mediaRunDiagnostic(
  org: string,
  agent: string,
  contact: string | null,
  job: MediaRunJob,
  messages: MediaRunMessage[],
): { conversation_id: string; inbound_message_id: string; media_decision: MediaDiagnostic } | null {
  const parsed = mediaDecisionSchema.safeParse(job.payload.media_intent_decision);
  if (!parsed.success) return null;
  const d = parsed.data;
  if (
    job.organization_id !== org ||
    job.contact_id !== contact ||
    d.organization_id !== org ||
    d.agent_id !== agent ||
    job.payload.conversation_id !== d.conversation_id ||
    job.payload.inbound_message_id !== d.inbound_message_id
  )
    return null;
  const attempts = messages.filter((m) => {
    const a = m.metadata?.approved_media as { media_id?: string; agent_id?: string } | undefined;
    const legacy = m.metadata?.approved_audio as
      { audio_id?: string; agent_id?: string } | undefined;
    return (
      m.organization_id === org &&
      m.conversation_id === d.conversation_id &&
      ((a?.media_id === d.audio_id && a?.agent_id === agent) ||
        (legacy?.audio_id === d.audio_id && legacy?.agent_id === agent))
    );
  });
  // Uma confirmação é evidência externa; queued/sending/uncertain nunca vira entrega.
  const confirmed = attempts.find(
    (m) => m.external_id || ["sent", "delivered", "read"].includes(m.status),
  );
  const attempt = confirmed ?? attempts[0];
  const phase = (attempt?.metadata?.outbound_attempt as { phase?: string } | undefined)?.phase;
  return {
    conversation_id: d.conversation_id,
    inbound_message_id: d.inbound_message_id,
    media_decision: {
      intent: d.intent,
      format: d.format,
      media_id: d.audio_id,
      title: d.selected_title,
      authorized: d.authorized_id !== null,
      reason: attempt?.error_code ?? d.reason,
      transport: confirmed ? "confirmed" : (phase ?? attempt?.status ?? "not_attempted"),
    },
  };
}
