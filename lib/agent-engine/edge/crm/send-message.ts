/**
 * Borda de saída pós-fusão: envio de mensagem SEMPRE via `sendMessageHandler` do
 * próprio app (app/api/v1/messages/_handler.ts) — o handler insere a linha
 * outbound, envia pelo WAHA, atualiza conversa, audita e emite evento; e dá de
 * graça o guard is_blocked (ApiError 403). A tool `send_message` do agente chama
 * ESTA função depois da cadeia de guardrails; nenhum output de modelo vira
 * mensagem sem passar por aqui.
 *
 * Idempotência (o handler NÃO tem idempotency key própria — o ledger cobre):
 *   1. transação lógica: insert em `send_ledger` (unique (job_id, seq)); o
 *      `send_ledger.id` É a idempotency_key, enviada em `metadata.idempotency_key`
 *      da mensagem;
 *   2. chamada ao handler; 'sent' → accepted; 'queued'/'failed' → registrados;
 *   3. `outbound-attempt` aplica a política única de recuperação por fase,
 *      confirmação do provedor e lease. Não rotaciona key por status failed;
 *      resultados incertos são terminais, nunca autorização de reenvio.
 */
import { executeOutboundAttempt, type OutboundAttemptOptions } from './outbound-attempt';

import type { Queryable } from '../../queue/queue';
import { cancelJob, rescheduleJob, type JobRow } from '../../queue/queue';
import { cancelPendingCronsForLead } from '../../cron/scheduler';
import type { CrmEdgeConfig } from './mcp-client';

export type SendLedgerStatus = 'requested' | 'accepted' | 'queued' | 'vetoed' | 'failed';

export interface SendLedgerRow {
  id: string;
  organization_id: string;
  contact_id: string | null;
  job_id: string;
  seq: number;
  body_hash: string;
  status: SendLedgerStatus;
  crm_message_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Erro de negócio não classificado do handler (ex.: conversa inexistente) — ledger fica 'requested'. */
export class SendToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendToolError';
  }
}

export type SendOutcome =
  | { kind: 'sent'; idempotencyKey: string; crmMessageId: string }
  /** Ledger já estava 'accepted' — replay pós-crash, nada a enviar. */
  | { kind: 'already_sent'; idempotencyKey: string; crmMessageId: string | null }
  /** CRM aceitou e SEGURA (sessão ≠ WORKING / waha_not_configured) — job reagendado, nunca dropado. */
  | { kind: 'queued'; idempotencyKey: string; crmMessageId: string | null }
  /** 403 is_blocked — veto PERMANENTE de negócio (opt-out, regra dura nº 2). */
  | { kind: 'blocked'; idempotencyKey: string }
  /** Falha sem confirmação: a política central decide se retry é seguro ou terminal. */
  | { kind: 'failed'; idempotencyKey: string; crmMessageId: string | null };

export interface SendMessageInput {
  workerId: string;
  tenantId: string;
  leadId: string | null;
  jobId: string;
  /** Posição da mensagem no turno (1..n) — com jobId forma a identidade da intenção. */
  seq: number;
  conversationId: string;
  body: string;
  /**
   * Presente = envio de TEMPLATE. O `body` continua sendo o texto RENDERIZADO — é
   * ele que entra no hash de idempotência e é ele que os gates de conteúdo avaliaram.
   * Trocar a chave por "nome do template" faria dois envios com valores diferentes
   * colidirem no ledger e o segundo virar `already_sent` sem ter saído.
   */
  template?: { name: string; language: string; values: Record<string, string> };
}

/** Fallback do ator ai_agent quando não há agente publicado (cfg.agentActorId). */
export const AGENT_ACTOR_ID = 'agent-engine';

/**
 * Envia UMA mensagem do turno pelo handler do app. Intenção exactly-once,
 * Todo consumidor usa o mesmo executor. Retry pré-rede retoma a identidade;
 * após entrada no transporte, só prova de rejeição permite retry automático.
 */
export async function sendTurnMessage(
  db: Queryable,
  cfg: CrmEdgeConfig,
  input: SendMessageInput,
  options?: OutboundAttemptOptions,
): Promise<SendOutcome> {
  return executeOutboundAttempt(db, cfg, input, options);
}

export type SendDisposition =
  /** Job cancelado em definitivo (veto is_blocked) — não re-tenta. */
  | { action: 'canceled'; job: JobRow | null }
  /** Job devolvido a 'pending' com run_after adiado, sem consumir attempts. */
  | { action: 'requeued'; job: JobRow | null }
  /** Nada a fazer com o job aqui: 'sent'/'already_sent' seguem para complete; 'failed' segue para failJob. */
  | { action: 'none' };

/**
 * Disposição do JOB conforme o outcome do envio:
 * - blocked → cancela o job (terminal — opt-out não é incidente) e cancela TODOS
 *   os follow-ups agendados do contato (irrevogável, regra dura nº 2). A fonte
 *   do bloqueio JÁ é contacts.is_blocked — não existe mais cache a atualizar;
 * - queued → reagenda com `delayMs` (knob SEND_QUEUED_RETRY_MS) SEM consumir
 *   attempts — sessão fora não pode matar mensagem de lead saudável;
 * - demais → responsabilidade do worker (complete/failJob pelos caminhos normais).
 */
export async function applySendOutcome(
  db: Queryable,
  outcome: SendOutcome,
  job: { jobId: string; workerId: string; tenantId: string; leadId: string | null },
  knobs: { queuedRetryDelayMs: number },
): Promise<SendDisposition> {
  switch (outcome.kind) {
    case 'blocked': {
      const canceled = await cancelJob(
        db,
        job.jobId,
        job.workerId,
        'envio vetado pelo sink: contato bloqueado (is_blocked) — opt-out irrevogável',
      );
      if (job.leadId) {
        await cancelPendingCronsForLead(db, job.tenantId, job.leadId);
      }
      return { action: 'canceled', job: canceled };
    }
    case 'queued': {
      const requeued = await rescheduleJob(db, job.jobId, job.workerId, {
        delayMs: knobs.queuedRetryDelayMs,
        reason: 'sessão do canal fora (resposta queued) — reagendado sem consumir attempts',
      });
      return { action: 'requeued', job: requeued };
    }
    default:
      return { action: 'none' };
  }
}
