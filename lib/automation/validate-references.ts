import type { SupabaseClient } from "@supabase/supabase-js";
import { schedulingBlockReason } from "./ai-binding-policy";

export async function publishedAutomationAgent(admin: SupabaseClient, org: string, id: string) {
  const { data: agent, error } = await admin.from("ai_agents").select("id,name,published_version_id")
    .eq("organization_id", org).eq("id", id).is("archived_at", null).maybeSingle();
  if (error) throw new Error("reference_lookup_failed");
  if (!agent?.published_version_id) return null;
  const { data: version, error: versionError } = await admin.from("ai_agent_versions")
    .select("id,operator_enabled,operator_tool_ids,pipeline_ids")
    .eq("organization_id", org).eq("agent_id", id).eq("id", agent.published_version_id).eq("status", "published").maybeSingle();
  if (versionError) throw new Error("reference_lookup_failed");
  if (!version) return null;
  return { id: agent.id as string, name: agent.name as string, operatorEnabled: version.operator_enabled === true,
    operatorToolIds: (version.operator_tool_ids ?? []) as string[], pipelineIds: (version.pipeline_ids ?? []) as string[] };
}

/** Escrita e vínculo usam a mesma validação, com IDs resolvidos dentro do tenant. */
export async function validateAutomationReferences(admin: SupabaseClient, org: string,
  actions: Array<{ type: string; config?: Record<string, unknown> }>, pipelineId?: string): Promise<string | null> {
  for (const action of actions) {
    const c = action.config ?? {};
    if (action.type === "bind_ai_agent" || action.type === "send_ai_message") {
      if (typeof c.agent_id !== "string") return "Agente inválido.";
      const agent = await publishedAutomationAgent(admin, org, c.agent_id);
      if (!agent) return "Agente não publicado ou indisponível nesta organização.";
      if (c.allow_scheduling === true) {
        const reason = schedulingBlockReason(agent, pipelineId);
        if (reason) return reason;
      }
    }
    if (["bind_ai_agent", "send_ai_message", "send_whatsapp_message"].includes(action.type) || (action.type === "start_message_flow" && c.channel_session_id !== undefined)) {
      const { data, error } = await admin.from("channel_sessions").select("id")
        .eq("organization_id", org).eq("id", String(c.channel_session_id)).maybeSingle();
      if (error) throw new Error("reference_lookup_failed");
      if (!data) return "Número de WhatsApp inválido nesta organização.";
    }
    if (action.type === "start_message_flow") {
      const { data, error } = await admin.from("followup_flow_pointers").select("id,active_version_id,status")
        .eq("organization_id", org).eq("id", String(c.flow_pointer_id)).maybeSingle();
      if (error) throw new Error("reference_lookup_failed");
      if (!data?.active_version_id || data.status !== "active") return "Follow-up não publicado ou indisponível nesta organização.";
    }
  }
  return null;
}
