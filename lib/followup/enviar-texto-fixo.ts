import type { SupabaseClient } from "@supabase/supabase-js";

import { sendInlineTurnMessage } from "@/lib/agent-engine/edge/crm/inline-send";
import { ApiError } from "@/lib/api/types";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { createSupabaseAdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import { logger } from "@/lib/logger";
import { followupNeedsTemplate, loadOfficialFollowupTemplate } from "@/lib/channels/followup-delivery";
import type { ChannelProvider } from "@/lib/channels";

function ponteSupabase(admin: SupabaseClient): TurnBridgeAdminClient {
  const base = createSupabaseAdminClient(admin);
  return {
    ...base,
    async loadEnrollmentById(orgId, id) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("*")
        .eq("id", id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return data as EnrollmentRow;
    },
  };
}

/** Envia o texto fixo do fluxo neste request — sem cron e sem agent-worker. */
export async function enviarTextoFixoPendente(
  admin: SupabaseClient,
  somenteContactIds?: string[],
): Promise<number> {
  const { data: jobs, error } = await admin
    .from("job_queue")
    .select("id, organization_id, contact_id, payload")
    .eq("kind", "followup_turn")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);

  let enviados = 0;
  const ponte = ponteSupabase(admin);
  for (const job of jobs ?? []) {
    const payload = (job.payload ?? {}) as FollowupJobRequest["payload"];
    const body = payload.fixed_body;
    const enrollmentId = payload.followup_enrollment_id;
    const nodeId = payload.node_id;
    const contactId = job.contact_id as string | null;
    if (typeof body !== "string" || !body || !enrollmentId || !nodeId || !contactId) continue;
    if (somenteContactIds && !somenteContactIds.includes(contactId)) continue;

    const { data: claimed, error: claimErr } = await admin
      .from("job_queue")
      .update({ status: "running" })
      .eq("id", job.id)
      .eq("organization_id", job.organization_id as string)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) continue;

    try {
      const { data: enr, error: enrollmentError } = await admin
        .from("followup_enrollments")
        .select("current_node_id, conversation_id")
        .eq("id", enrollmentId)
        .eq("organization_id", job.organization_id as string)
        .eq("contact_id", contactId)
        .maybeSingle();
      if (enrollmentError) throw new Error('followup_enrollment_lookup_failed');
      if (!enr || enr.current_node_id !== nodeId) {
        await admin.from("job_queue").update({ status: "done" }).eq("id", job.id)
          .eq('organization_id', job.organization_id as string);
        continue;
      }
      const message = await sendInlineTurnMessage(admin, {
        organization_id: job.organization_id as string,
        actor: { type: 'webhook_source', id: enrollmentId }, requestId: `followup:${job.id}`,
      }, job.id as string, contactId, async () => {
        const boundConversationId = (enr.conversation_id as string | null) ?? undefined;
        const sessionId = await sessaoProntaParaEnvio(admin, job.organization_id as string, contactId, undefined, boundConversationId);
        if (!sessionId) throw new Error('outbound_session_unavailable');
        const conversationId = await ensureConversation(
          admin,
          job.organization_id as string,
          contactId,
          sessionId,
        );
        if (boundConversationId && conversationId !== boundConversationId) throw new Error('followup_conversation_mismatch');

        // GATE DE ELEGIBILIDADE — este envio inline BYPASSA `executarTurnoDoAgente`
        // (é o atalho "sem cron e sem agent-worker"), então precisa da checagem
        // por conta própria. Mesma regra pura do drain/turno. Canal 'open' → passa.
        // Bloqueio definitivo → o follow-up NÃO sai e o job vira `done`. Erro de
        // leitura → job volta pra `pending` (pode ser transitório) — fail-closed:
        // não envia sem confirmar.
        const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: job.organization_id as string,
          conversationId,
          agora: new Date(),
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        if (elegib !== null && !elegib.permite) {
          logger.info("[followup] texto fixo não enviado — conversa não elegível para IA", {
            organization_id: job.organization_id,
            conversation_id: conversationId,
            motivo: elegib.motivo,
          });
          throw new Error('followup_not_eligible');
        }

        const { data: conversation, error: conversationError } = await admin.from("conversations")
          .select("last_inbound_at, channel_sessions:channel_session_id(provider)")
          .eq("organization_id", job.organization_id as string).eq("id", conversationId)
          .eq("channel_session_id", sessionId).maybeSingle();
        if (conversationError || !conversation) throw new Error("followup_conversation_lookup_failed");
        const window = conversation as unknown as {
          last_inbound_at: string | null; channel_sessions: { provider: ChannelProvider } | null;
        };
        if (!window.channel_sessions) throw new Error("followup_session_missing");
        const official = followupNeedsTemplate(window.channel_sessions.provider, window.last_inbound_at, new Date())
          ? await loadOfficialFollowupTemplate(admin, job.organization_id as string, sessionId,
            payload.fallback_template_id, payload.fallback_template_values)
          : null;
        return official ? { conversation_id: conversationId, type: "template", body: official.body,
            template_name: official.template.name, template_language: official.template.language,
            template_values: official.template.values }
            : { conversation_id: conversationId, type: "text", body };
      });
      if (!['sent', 'delivered', 'read'].includes(message.status)) {
        const { error: pendingError } = await admin.from('job_queue').update({
          status: message.status === 'failed' ? 'dead' : 'pending',
          last_error: message.error_code ?? 'followup_send_not_confirmed',
        }).eq('id', job.id).eq('organization_id', job.organization_id as string);
        if (pendingError) throw new Error('followup_job_update_failed');
        continue;
      }
      enviados++;
      await completeTurnForEnrollment(ponte, job.organization_id as string, enrollmentId, nodeId, { kind: "sent" });
      const { error: doneErr } = await admin.from("job_queue").update({ status: "done" }).eq("id", job.id)
        .eq('organization_id', job.organization_id as string);
      if (doneErr) throw new Error(doneErr.message);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      const terminal = /^(messaging_window_closed|followup_template_(not_found|not_approved|missing_values))/.test(message);
      logger.warn("[dev.pipeline] envio inline falhou", { error: message });
      await admin
        .from("job_queue")
        .update({ status: message === 'followup_not_eligible' ? 'done' : terminal ? "dead" : "pending", last_error: message.slice(0, 300) })
        .eq("id", job.id).eq('organization_id', job.organization_id as string);
    }
  }
  return enviados;
}
