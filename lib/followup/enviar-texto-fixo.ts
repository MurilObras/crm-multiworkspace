import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { getRequestPool } from '@/lib/agent-engine/db/request-pool';
import { loadEnv } from '@/lib/agent-engine/env';
import { claimJobs, completeJob, cancelJob, failJob, rescheduleJob } from '@/lib/agent-engine/queue/queue';
import { OutboundLeaseLostError } from '@/lib/channels/delivery-error';

import { sendInlineTurnMessage } from "@/lib/agent-engine/edge/crm/inline-send";
import { ApiError } from "@/lib/api/types";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import type { FollowupJobRequest } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { logger } from "@/lib/logger";
import { followupNeedsTemplate, loadOfficialFollowupTemplate } from "@/lib/channels/followup-delivery";
import type { ChannelProvider } from "@/lib/channels";

export interface InlineExecution {
  pool: pg.Pool;
  workerId: string;
  maxConcurrency: number;
  queuedRetryDelayMs: number;
}

/** Envia o texto fixo do fluxo neste request — sem cron e sem agent-worker. */
export async function enviarTextoFixoPendente(
  admin: SupabaseClient,
  somenteContactIds?: string[],
  execution?: InlineExecution,
): Promise<number> {
  const { data: jobs, error } = await admin
    .from("job_queue")
    .select("id, organization_id, contact_id, payload")
    .eq("kind", "followup_turn")
    .eq("status", "pending")
    .lte('run_after', new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);
  const candidates = (jobs ?? []).filter((job) => {
    const p = job.payload as FollowupJobRequest['payload'];
    return p?.fixed_body && p.followup_enrollment_id && p.node_id && job.contact_id &&
      (!somenteContactIds || somenteContactIds.includes(job.contact_id));
  });
  if (!candidates.length) return 0;
  const runtime = execution ?? (() => {
    const env = loadEnv();
    return { pool: getRequestPool(), workerId: `inline:${randomUUID()}`,
      maxConcurrency: env.QUEUE_MAX_CONCURRENCY, queuedRetryDelayMs: env.SEND_QUEUED_RETRY_MS };
  })();
  const { pool, workerId } = runtime;
  const claimedJobs = await claimJobs(pool, { workerId, maxConcurrency: runtime.maxConcurrency,
    batchSize: 5, jobIds: candidates.map((job) => job.id) });

  let enviados = 0;
  for (const job of claimedJobs) {
    const payload = (job.payload ?? {}) as FollowupJobRequest["payload"];
    const body = payload.fixed_body;
    const enrollmentId = payload.followup_enrollment_id;
    const nodeId = payload.node_id;
    const contactId = job.contact_id as string | null;
    if (typeof body !== "string" || !body || !enrollmentId || !nodeId || !contactId) continue;
    if (somenteContactIds && !somenteContactIds.includes(contactId)) continue;

    try {
      const { data: enr, error: enrollmentError } = await admin
        .from("followup_enrollments")
        .select("current_node_id, conversation_id, status")
        .eq("id", enrollmentId)
        .eq("organization_id", job.organization_id as string)
        .eq("contact_id", contactId)
        .maybeSingle();
      if (enrollmentError) throw new Error('followup_enrollment_lookup_failed');
      if (!enr || enr.current_node_id !== nodeId || ["cancelled", "completed", "paused_handoff"].includes(enr.status)) {
        await completeJob(pool, job.id, workerId);
        continue;
      }
      const message = await sendInlineTurnMessage(pool, admin, {
        organization_id: job.organization_id as string,
        actor: { type: 'webhook_source', id: enrollmentId }, requestId: `followup:${job.id}`,
      }, job.id as string, contactId, workerId, async () => {
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
        if (message.status === 'queued') await rescheduleJob(pool, job.id, workerId, {
          delayMs: runtime.queuedRetryDelayMs, reason: 'followup_send_queued',
        });
        else if (message.status === 'blocked') await cancelJob(pool, job.id, workerId, 'contact_blocked');
        else await failJob(pool, job.id, workerId, message.error_code ?? 'followup_send_not_confirmed');
        continue;
      }
      enviados++;
      await completeJob(pool, job.id, workerId, async (tx) => {
        await completeTurnForEnrollment(createPgAdminClient(tx), job.organization_id, enrollmentId, nodeId, { kind: 'sent' });
      });
    } catch (err) {
      if (err instanceof OutboundLeaseLostError) continue;
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      const terminal = /^(messaging_window_closed|followup_template_(not_found|not_approved|missing_values))/.test(message);
      logger.warn("[dev.pipeline] envio inline falhou", { error: message });
      if (message === 'followup_not_eligible' || terminal) await cancelJob(pool, job.id, workerId, message);
      else await failJob(pool, job.id, workerId, message);
    }
  }
  return enviados;
}
