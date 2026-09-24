import { expect, it } from "vitest";
import { createAutomationRuleSchema, updateAutomationRuleSchema } from "./webhooks";

it("ligar/pausar/renomear preserva condições omitidas no PATCH", () => {
  for (const patch of [{ is_active: true }, { is_active: false }, { name: "Novo nome" }]) {
    expect(updateAutomationRuleSchema.parse(patch)).toEqual(patch);
  }
});
it("limpar condições exige intenção explícita; criação ainda recebe default", () => {
  expect(updateAutomationRuleSchema.parse({ conditions: [] })).toEqual({ conditions: [] });
  expect(createAutomationRuleSchema.parse({ name: "Regra", trigger_event: "lead.created", actions: [{ type: "add_tag", config: { tags: ["tag"] } }] }).conditions).toEqual([]);
});
