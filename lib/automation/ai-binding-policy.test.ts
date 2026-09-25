import { expect, it } from "vitest";
import { APPOINTMENT_TOOLS, schedulingBlockReason, withBindingPolicy } from "./ai-binding-policy";
import { buildKiwifyPurchaseAutomation } from "./kiwify-automation";
import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";

it("pós-compra usa ações canônicas em ordem e não cria compromisso ao qualificar", () => {
  const rule = buildKiwifyPurchaseAutomation({ name: "Compra", productId: "product", channelSessionId: "channel", agentId: "agent", aiInstruction: "Agradeça a compra", continueAi: true, flowPointerId: "flow", allowScheduling: true });
  expect(rule.actions.map(a => a.type)).toEqual(["send_ai_message", "bind_ai_agent", "start_message_flow"]);
  expect(rule.actions[1]?.config).toMatchObject({ agent_id: "agent", allow_scheduling: true });
});
it("agendamento exige operator, ferramentas publicadas e permissão no funil", () => {
  const ready = { operatorEnabled: true, operatorToolIds: [...APPOINTMENT_TOOLS], pipelineIds: ["pipeline"] };
  expect(schedulingBlockReason(ready, "pipeline")).toBeNull();
  expect(schedulingBlockReason({ ...ready, operatorEnabled: false }, "pipeline")).not.toBeNull();
  for (const tool of APPOINTMENT_TOOLS) expect(schedulingBlockReason({ ...ready, operatorToolIds: ready.operatorToolIds.filter(t => t !== tool) }, "pipeline")).not.toBeNull();
  expect(schedulingBlockReason(ready, "other-tenant-pipeline")).not.toBeNull();
});
it("política não concede ferramentas e bloqueia booking quando opção está desligada", () => {
  const config = { systemPrompt: "Prompt publicado", operatorEnabled: true, operatorToolIds: [...APPOINTMENT_TOOLS], toolIds: [...APPOINTMENT_TOOLS], pipelineIds: ["pipeline"] } as PublishedAgentConfig;
  const disabled = withBindingPolicy(config, false);
  expect(disabled.operatorToolIds).not.toContain("crm_book_appointment");
  expect(disabled.toolIds).not.toContain("crm_book_appointment");
  expect(config.operatorToolIds).toContain("crm_book_appointment");
  const enabled = withBindingPolicy(config, true);
  expect(enabled.operatorToolIds).toEqual(config.operatorToolIds);
  expect(enabled.systemPrompt).toContain("Somente após ele escolher/confirmar");
  const restricted = withBindingPolicy({ ...config, operatorToolIds: [] }, true);
  expect(restricted.operatorToolIds).toEqual([]);
  expect(restricted.toolIds).not.toContain("crm_book_appointment");
});
