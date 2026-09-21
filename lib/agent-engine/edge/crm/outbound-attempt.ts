import { createHash } from 'node:crypto';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import { ApiError } from '@/lib/api/types';
import type { SendMessageInput as SinkInput } from '@/lib/schemas';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import { OutboundLeaseLostError, type OutboundAttemptWrite } from '@/lib/channels/delivery-error';
import type { Message } from '@/lib/types/messaging';
import { cancelJob, type Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import type { SendMessageInput, SendOutcome } from './send-message';
import { decideOutboundRecovery, type RecoveryMessage } from './outbound-recovery';

export interface OutboundAttemptOptions {
  actor?: HandlerCtx['actor'];
  prepare?: () => Promise<SinkInput>;
}

/** Um protocolo de envio usado pelos DOIS consumidores. Os CTEs de owner tomam
 * lock na mesma linha que o reaper: quem perdeu lease não prepara transporte.
 * messages.id = ledger.id na criação torna crash pré-insert retomável sem criar
 * outra mensagem. O CAS prepared -> started é o limite de incerteza da rede. */
export async function executeOutboundAttempt(
  db: Queryable, cfg: CrmEdgeConfig, input: SendMessageInput, options: OutboundAttemptOptions = {},
): Promise<SendOutcome> {
  const { tenantId: org, leadId: contact, jobId: job, workerId: owner, seq } = input;
  if (!owner) throw new OutboundLeaseLostError();
  const hash = (body: string) => createHash('sha256').update(body).digest('hex');
  const claim = await db.query<{ id: string; status: string }>(
    `with owner as materialized (
       select id from job_queue where id=$1 and organization_id=$2 and contact_id is not distinct from $3
         and status='running' and locked_by=$4 for update
     ) insert into send_ledger (organization_id,contact_id,job_id,seq,body_hash)
       select $2,$3,id,$5,$6 from owner on conflict (job_id,seq) do nothing returning id,status`,
    [job, org, contact, owner, seq, hash(input.body)],
  );
  let ledger = claim.rows[0];
  if (!ledger) {
    const found = await db.query<{ id: string; status: string }>(
      `select l.id,l.status from send_ledger l join job_queue j on j.id=l.job_id and j.organization_id=l.organization_id
       where l.organization_id=$1 and l.contact_id is not distinct from $2 and l.job_id=$3 and l.seq=$4
         and j.status='running' and j.locked_by=$5`, [org, contact, job, seq, owner],
    );
    ledger = found.rows[0];
  }
  if (!ledger) throw new OutboundLeaseLostError();
  const key = ledger.id;
  const readMessage = async (): Promise<RecoveryMessage | null> => {
    const { rows } = await db.query<RecoveryMessage>(
      `select id,status,external_id,error_code,metadata from messages
       where organization_id=$1 and contact_id is not distinct from $2 and direction='outbound'
         and metadata->>'idempotency_key'=$3`, [org, contact, key],
    );
    if (rows.length > 1) throw new Error('outbound_duplicate_identity');
    return rows[0] ?? null;
  };
  // O mesmo fence protege resultado, erro e requeue. Em particular, o booleano
  // local "transportStarted=false" de A não autoriza apagar o started de B.
  const writeAttemptState = async (id: string, change: OutboundAttemptWrite): Promise<Message> => {
    const { rows } = await db.query<Message>(
      `with owner as materialized (
         select id from job_queue where id=$1 and organization_id=$2 and locked_by=$3
           and contact_id is not distinct from $10 and status='running' for update
       ) update messages m set
         status=coalesce($8::jsonb->>'status',m.status),
         error_code=case when $8::jsonb ? 'error_code' then $8::jsonb->>'error_code' else m.error_code end,
         error_message=case when $8::jsonb ? 'error_message' then $8::jsonb->>'error_message' else m.error_message end,
         external_id=case when $8::jsonb ? 'external_id' then $8::jsonb->>'external_id' else m.external_id end,
         ack=case when $8::jsonb ? 'ack' then ($8::jsonb->>'ack')::integer else m.ack end,
         template_name=case when $8::jsonb ? 'template_name' then $8::jsonb->>'template_name' else m.template_name end,
         template_language=case when $8::jsonb ? 'template_language' then $8::jsonb->>'template_language' else m.template_language end,
         metadata=coalesce(m.metadata,'{}'::jsonb) || $6::jsonb || jsonb_build_object(
           'outbound_attempt',coalesce(m.metadata->'outbound_attempt','{}'::jsonb) || $7::jsonb)
       where m.id=$4 and m.organization_id=$2 and m.contact_id is not distinct from $10
         and m.metadata->>'idempotency_key'=$9
         and (m.metadata->'outbound_attempt'->>'phase') is not distinct from $5::text
         and (m.status not in ('sent','delivered','read') or m.external_id is null)
         and exists(select 1 from owner) returning m.*`,
      [job, org, owner, id, change.expectedPhase,
        JSON.stringify(change.queuedReason === undefined ? {} : { queued_reason: change.queuedReason }),
        JSON.stringify({ phase: change.phase, ...(change.retryable === undefined ? {} : { retryable: change.retryable }) }),
        JSON.stringify(change.patch), key, contact],
    );
    if (!rows[0]) throw new OutboundLeaseLostError();
    return rows[0];
  };
  const saveLedger = async (status: string, messageId: string | null, error: string | null) => {
    const {rows} = await db.query(`with owner as materialized (
      select id from job_queue where id=$6 and organization_id=$5 and status='running' and locked_by=$8 for update
    ) update send_ledger set status=$1,crm_message_id=coalesce($2,crm_message_id),last_error=$3,updated_at=now()
      where id=$4 and organization_id=$5 and job_id=$6 and seq=$7 and exists(select 1 from owner) returning id`,
      [status, messageId, error, key, org, job, seq, owner]);
    if (!rows.length) throw new OutboundLeaseLostError();
  };
  const settle = async (message: RecoveryMessage | null, afterSend: boolean): Promise<SendOutcome | null> => {
    const decision = decideOutboundRecovery(ledger!.status, message);
    if (decision === 'confirmed') {
      await saveLedger('accepted', message!.id, null);
      return { kind: afterSend ? 'sent' : 'already_sent', idempotencyKey: key, crmMessageId: message!.id };
    }
    if (decision === 'retry_safe') {
      if (!afterSend) return null;
      const queued = message?.status === 'queued';
      await saveLedger(queued ? 'queued' : 'failed', message?.id ?? null, message?.error_code ?? 'outbound_pre_network_failure');
      return { kind: queued ? 'queued' : 'failed', idempotencyKey: key, crmMessageId: message?.id ?? null };
    }
    const reason = decision === 'uncertain' ? 'outbound_delivery_uncertain' : 'outbound_rejected_terminal';
    if (message && decision === 'uncertain') {
      const phase = (message.metadata?.outbound_attempt as { phase?: string } | undefined)?.phase ?? null;
      try {
        await writeAttemptState(message.id, { expectedPhase: phase, phase: 'uncertain', patch: { status: 'failed', error_code: reason } });
      } catch (error) {
        if (error instanceof OutboundLeaseLostError) {
          const latest = await readMessage();
          if (decideOutboundRecovery(ledger!.status, latest) === 'confirmed') return settle(latest, afterSend);
        }
        throw error;
      }
      const latest = await readMessage();
      if (decideOutboundRecovery(ledger!.status, latest) === 'confirmed') return settle(latest, afterSend);
    }
    await saveLedger('failed', message?.id ?? null, reason);
    await cancelJob(db, job, owner, reason);
    return { kind: 'failed', idempotencyKey: key, crmMessageId: message?.id ?? null };
  };
  const previous = await readMessage();
  const outcome = await settle(previous, false);
  if (outcome) return outcome;

  const persisted = (previous?.metadata?.outbound_attempt as { input?: SinkInput } | undefined)?.input;
  const prepared: SinkInput = persisted ?? (options.prepare ? await options.prepare() : {
    conversation_id: input.conversationId, body: input.body,
    ...(input.template ? { type: 'template', template_name: input.template.name,
      template_language: input.template.language, template_values: input.template.values } : { type: 'text' }),
  });
  const messageId = previous?.id ?? key;
  try {
    await sendMessageHandler(cfg.supabase, { organization_id: org, requestId: key,
      actor: options.actor ?? { type: 'ai_agent', id: cfg.agentActorId ?? 'agent-engine', role: 'manager' } }, {
      ...prepared, metadata: { ...prepared.metadata, idempotency_key: key,
        outbound_attempt: { phase: 'prepared', input: { ...prepared, metadata: undefined } } },
    }, {
      messageId,
      writeAttemptState: (message, change) => writeAttemptState(message.id, change),
      beforeSend: async () => {
        const { rows } = await db.query<{ id: string }>(
          `with owner as materialized (select id from job_queue where id=$1 and organization_id=$2
             and status='running' and locked_by=$3 for update),
           prepared as (update messages set status='queued',
             metadata=coalesce(metadata,'{}'::jsonb) || $7::jsonb
             where id=$4 and organization_id=$2 and exists(select 1 from owner)
               and status in ('queued','failed') and external_id is null
               and (metadata->'outbound_attempt'->'input' is null or
                    metadata->'outbound_attempt'->'input'=($7::jsonb)->'outbound_attempt'->'input')
               and coalesce(metadata->'outbound_attempt'->>'phase','prepared') in ('prepared','rejected') returning id)
           update send_ledger set crm_message_id=$4,body_hash=$5 where id=$6 and organization_id=$2
             and exists(select 1 from prepared) returning id`,
          [job, org, owner, messageId, hash(prepared.body ?? ''), key,
            JSON.stringify({ idempotency_key: key, outbound_attempt: { phase: 'prepared', input: { ...prepared, metadata: undefined } } })],
        );
        if (!rows.length) throw new OutboundLeaseLostError();
      },
      beforeTransport: async () => {
        const { rows } = await db.query<{ id: string }>(
          `with owner as materialized (select id from job_queue where id=$1 and organization_id=$2
             and status='running' and locked_by=$3 for update)
           update messages set status='sending',
              metadata=jsonb_set(metadata,'{outbound_attempt,phase}','"started"'::jsonb)
                || coalesce((select jsonb_build_object('automation_destination_phone',c.phone_number)
                  from contacts c where c.id=messages.contact_id and c.organization_id=$2
                    and not c.is_anonymized), '{}'::jsonb)
           where id=$4 and organization_id=$2 and status='queued'
             and metadata->'outbound_attempt'->>'phase'='prepared'
             and exists(select 1 from owner) returning id`, [job, org, owner, messageId],
        );
        if (!rows.length) throw new OutboundLeaseLostError();
      },
    });
  } catch (error) {
    if (error instanceof OutboundLeaseLostError) throw error;
    if (error instanceof ApiError && error.status === 403) {
      await saveLedger('vetoed', previous?.id ?? null, 'contact_blocked');
      return { kind: 'blocked', idempotencyKey: key };
    }
    // Se a rede pode ter começado, settle fecha a tentativa como incerta. Antes
    // da criação da mensagem, preserva requested para retomada sob novo lease.
    const message = await readMessage();
    if (message) return (await settle(message, true))!;
    throw error;
  }
  return (await settle(await readMessage(), true))!;
}
