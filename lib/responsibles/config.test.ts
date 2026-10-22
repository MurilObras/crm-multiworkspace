import { describe, expect, it } from "vitest";
import { consultationSettingsSchema, consultationInstructions, DEFAULT_CONSULTATION, responsibleSchema } from "./config";

describe("consulta ao responsável: configuração e identidade do aviso", () => {
  it("permanece desligada sem destinatários e não injeta instruções", () => {
    expect(consultationSettingsSchema.parse(DEFAULT_CONSULTATION).enabled).toBe(false);
    expect(consultationInstructions(DEFAULT_CONSULTATION)).toBe("");
    expect(consultationSettingsSchema.safeParse({ ...DEFAULT_CONSULTATION, enabled: true }).success).toBe(false);
  });
  it("rejeita número incompleto, extensões e configuração desconhecida", () => {
    for (const phone of ["11999999999", "+5511", "+5511999999999 ramal 2"]) expect(responsibleSchema.safeParse({ name: "Pessoa", phone }).success).toBe(false);
    expect(consultationSettingsSchema.safeParse({ ...DEFAULT_CONSULTATION, organization_id: "outra" }).success).toBe(false);
  });
  it("inclui as situações configuradas e separa consulta de transferência", () => {
    const text = consultationInstructions({ enabled: true, conditions: "Descontos fora da política." });
    expect(text).toContain("Descontos fora da política."); expect(text).toContain("open_human_case");
    expect(text).toContain("request_human_handoff"); expect(text).toContain("encerre o turno");
  });
});
