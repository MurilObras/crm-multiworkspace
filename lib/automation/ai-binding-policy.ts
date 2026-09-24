import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";

/** Origem explícita do sticky; handoff humano já limpa active_intent e o agente. */
export const AUTOMATION_AGENT_INTENT = "automation:bound";
export const APPOINTMENT_TOOLS = [
  "crm_list_event_types", "crm_find_free_slots", "crm_list_appointments", "crm_book_appointment",
] as const;

export function schedulingBlockReason(config: Pick<PublishedAgentConfig, "operatorEnabled" | "operatorToolIds" | "pipelineIds">, pipelineId?: string): string | null {
  if (!config.operatorEnabled) return "O agente publicado não tem o papel Operador habilitado.";
  if (!APPOINTMENT_TOOLS.every(tool => config.operatorToolIds.includes(tool))) return "O Operador precisa das quatro ferramentas de consulta e agendamento publicadas.";
  if (!config.pipelineIds.length || (pipelineId && !config.pipelineIds.includes(pipelineId))) return "O agente publicado não tem permissão de escrita neste funil.";
  return null;
}

/** Restrição por conversa: nunca acrescenta capacidade à versão publicada. */
export function withBindingPolicy(config: PublishedAgentConfig, allowScheduling: boolean): PublishedAgentConfig {
  const allowed = allowScheduling && schedulingBlockReason(config) === null;
  const removeBooking = (tools: string[]) => tools.filter(tool => !["crm_book_appointment", "crm_reschedule_appointment"].includes(tool));
  return {
    ...config,
    toolIds: allowed ? config.toolIds : removeBooking(config.toolIds),
    operatorToolIds: allowed ? config.operatorToolIds : removeBooking(config.operatorToolIds),
    systemPrompt: `${config.systemPrompt}\n\nPós-compra: qualifique usando o contexto, conhecimento e skills publicados. ${allowed
      ? "Para agendar, consulte tipos, compromissos e horários reais pelas ferramentas. Ofereça opções ao cliente. Somente após ele escolher/confirmar um horário, crie o compromisso. Uma boa qualificação nunca é confirmação de horário. Não invente disponibilidade."
      : "A tentativa de agendamento não foi habilitada nesta conversa. Não crie nem prometa compromisso."}`,
  };
}
