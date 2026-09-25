import { z } from "zod";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { loadPublishedAgentConfigById } from "@/lib/agent-engine/agent/agent-config";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { AUTOMATION_AGENT_INTENT, schedulingBlockReason } from "@/lib/automation/ai-binding-policy";

const schema = z.object({ agent_id: z.uuid(), channel_session_id: z.uuid(), allow_scheduling: z.boolean().default(false) });
export async function executeBindAiAgent(ctx: ActionCtx, raw: Record<string, unknown>): Promise<ActionResultDetail> {
  const type = "bind_ai_agent";
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { type, status: "failed", error: "invalid_config" };
  const guard = checarGuardasDeContato(ctx);
  if (!guard.ok) return { type, status: "skipped", detail: { reason: guard.reason } };
  const config = parsed.data;
  const pool = getRequestPool();
  const agent = await loadPublishedAgentConfigById(pool, ctx.organizationId, config.agent_id);
  if (!agent) return { type, status: "failed", error: "sem_agente_publicado" };
  const lead = ctx.context.lead as { pipeline_id?: string } | undefined;
  if (config.allow_scheduling && schedulingBlockReason(agent, lead?.pipeline_id)) return { type, status: "failed", error: "scheduling_unavailable" };
  const conversationId = await ensureConversation(ctx.admin, ctx.organizationId, guard.contact.id, config.channel_session_id);
  await autorizarContatoParaIA(ctx.admin, { organizationId: ctx.organizationId, contactId: guard.contact.id, reason: `automacao:${ctx.ruleId}` });
  // Update e auditoria são um único statement. O intent do motor impede replay;
  // a condição DISTINCT também torna repetir o binding um no-op.
  const { rows } = await pool.query<{ id: string }>(`
    with bound as (
      update conversations c set active_ai_agent_id=$3,active_intent=$4,active_agent_set_at=now(),
        metadata=jsonb_set(coalesce(c.metadata,'{}'),'{automation_binding}',jsonb_build_object('allow_scheduling',$5::boolean))
      where c.organization_id=$1 and c.id=$2
        and (c.active_ai_agent_id is distinct from $3::uuid or c.active_intent is distinct from $4::text
          or c.metadata->'automation_binding' is distinct from jsonb_build_object('allow_scheduling',$5::boolean))
        and exists(select 1 from ai_agents a join ai_agent_versions v on v.id=a.published_version_id
          where a.organization_id=$1 and a.id=$3 and a.archived_at is null
            and v.organization_id=$1 and v.agent_id=a.id and v.status='published')
        and exists(select 1 from contacts contact where contact.organization_id=$1 and contact.id=c.contact_id
          and not coalesce(contact.is_blocked,false) and not coalesce(contact.is_anonymized,false)
          and not coalesce((contact.consent #> '{marketing,declined_at}') not in
            ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb),false))
      returning c.id
    ), logged as (
      insert into api_audit_log(organization_id,action,resource_type,resource_id,request_id,metadata)
      select $1,'automation.ai_agent_bound','conversation',id,$6,
        jsonb_build_object('agent_id',$3::uuid,'rule_id',$7::uuid,'allow_scheduling',$5::boolean) from bound
    ) select id from bound`,
  [ctx.organizationId, conversationId, agent.agentId, AUTOMATION_AGENT_INTENT, config.allow_scheduling, ctx.requestId, ctx.ruleId]);
  if (!rows.length) {
    const { rows: current } = await pool.query("select id from conversations where organization_id=$1 and id=$2 and active_ai_agent_id=$3 and active_intent=$4", [ctx.organizationId, conversationId, agent.agentId, AUTOMATION_AGENT_INTENT]);
    if (!current.length) return { type, status: "failed", error: "sem_agente_publicado" };
  }
  return { type, status: "success", detail: { conversation_id: conversationId, agent_id: agent.agentId } };
}
registerAction({ type: "bind_ai_agent", execute: executeBindAiAgent });
