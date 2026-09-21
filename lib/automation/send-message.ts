import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { OutboundLeaseLostError } from "@/lib/channels/delivery-error";
import type { Message } from "@/lib/types/messaging";
import type { SendMessageInput } from "@/lib/schemas";
import type { ActionCtx } from "./types";
import { adiarAteAJanelaAbrir } from "./janela-do-canal";
import { checkDailyLimit } from "./throttle";
import { ApiError } from "@/lib/api/types";

/** Reusa o sink e seu protocolo prepared → started → rejected/uncertain.
 * A aquisição pertence ao run, em vez do job_queue do agente. Não existe
 * retomada de uma ação já adquirida: callbacks ainda podem confirmar o resultado.
 */
export async function sendAutomationMessage(ctx: ActionCtx, input: SendMessageInput) {
  const handlerCtx = { organization_id: ctx.organizationId,
    actor: { type: "webhook_source" as const, id: ctx.ruleId }, requestId: `rule:${ctx.ruleId}` };
  const id = ctx.actionIntentId;
  if (!id) return sendMessageHandler(ctx.admin, handlerCtx, input);
  const db = getRequestPool();
  const org = ctx.organizationId;
  return sendMessageHandler(ctx.admin, handlerCtx, {
    ...input, metadata: { ...input.metadata, idempotency_key: id,
      outbound_attempt: { phase: "prepared" } },
  }, {
    messageId: id,
    beforeSend: async (message) => {
      const { rows } = await db.query(`update automation_rule_runs r set message_id=m.id
        from messages m where r.id=$1 and r.organization_id=$2 and r.execution_state='preparing'
        and m.id=$3 and m.organization_id=r.organization_id returning r.id`, [id,org,message.id]);
      if (!rows.length) throw new OutboundLeaseLostError();
    },
    beforeTransport: async (message) => {
      if (await adiarAteAJanelaAbrir(ctx.admin,org,message.channel_session_id)) {
        throw new ApiError(403,"forbidden",undefined,ctx.requestId,"fora_da_janela_de_envio");
      }
      if (!(await checkDailyLimit(ctx.admin,org,message.channel_session_id)).allowed) {
        throw new ApiError(403,"forbidden",undefined,ctx.requestId,"daily_limit");
      }
      const { rows } = await db.query(`with eligible as materialized (
        select m.id,c.phone_number from messages m join contacts c on c.id=m.contact_id
          and c.organization_id=m.organization_id where m.id=$3 and m.organization_id=$2
          and not c.is_blocked and not c.is_anonymized and c.phone_number=$4
          and public.fn_automation_run_live($2,$1,c.id)
          and coalesce(c.consent #> '{marketing,declined_at}','null'::jsonb) in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
          and m.metadata->'outbound_attempt'->>'phase'='prepared' for update of c
      ), acquired as (
        update automation_rule_runs set execution_state='sending',execution_updated_at=now()
        where id=$1 and organization_id=$2 and execution_state='preparing'
          and exists(select 1 from eligible) returning id
      ) update messages m set status='sending',
        metadata=jsonb_set(m.metadata,'{outbound_attempt,phase}','"started"'::jsonb)
          || jsonb_build_object('automation_destination_phone',c.phone_number)
        from contacts c where m.id=$3 and m.organization_id=$2 and exists(select 1 from acquired)
          and c.id=m.contact_id and c.organization_id=m.organization_id
          and not c.is_blocked and not c.is_anonymized
          and m.metadata->'outbound_attempt'->>'phase'='prepared' returning m.id`,
        [id,org,message.id,(ctx.context.contact as { phone_number?: string } | undefined)?.phone_number]);
      if (!rows.length) throw new ApiError(403,"forbidden",undefined,ctx.requestId,"recipient_changed");
    },
    writeAttemptState: async (message, change) => {
      const patch = change.patch;
      const blocked = patch.error_code === "automatic_send_blocked";
      const unconfirmed = patch.status === "sent" && !patch.external_id;
      const state = unconfirmed ? "uncertain" : patch.status === "sent" ? "accepted"
        : change.phase === "uncertain" ? "uncertain"
        : change.phase === "rejected" ? "rejected"
        : patch.status === "queued" || blocked ? "blocked" : "failed_before_send";
      const { rows } = await db.query<Message>(`with acquired as (
        update automation_rule_runs set execution_state=$4,execution_updated_at=now()
        where id=$1 and organization_id=$2 and (execution_state=$5
          or (execution_state='uncertain' and $5='sending' and $4='accepted')) returning id
      ) update messages m set
        status=case when m.status in ('delivered','read') then m.status else $6 end,
        external_id=coalesce($7,m.external_id),error_code=$8,error_message=null,
        ack=case when $10::integer is null then m.ack else greatest(m.ack,$10::integer) end,
        metadata=jsonb_set(m.metadata,'{outbound_attempt,phase}',to_jsonb($9::text))
        where m.id=$3 and m.organization_id=$2 and exists(select 1 from acquired) returning m.*`,
      [id,org,message.id,state,change.expectedPhase === "started" ? "sending" : "preparing",
        unconfirmed || patch.status === "queued" ? "failed" : patch.status,patch.external_id ?? null,
        unconfirmed ? "outbound_delivery_uncertain" : blocked ? patch.error_message : change.queuedReason ?? patch.error_code ?? null,
        unconfirmed ? "uncertain" : change.phase,patch.ack ?? null]);
      if (!rows[0]) throw new OutboundLeaseLostError();
      return rows[0];
    },
  }).catch(async (error: unknown) => {
    if (error instanceof ApiError && error.status === 403) {
      await db.query("update automation_rule_runs set execution_state='blocked',execution_updated_at=now() where id=$1 and organization_id=$2 and execution_state='preparing'",[id,org]);
    }
    throw error;
  });
}
