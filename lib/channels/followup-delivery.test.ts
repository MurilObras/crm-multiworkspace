import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { followupNeedsTemplate, loadOfficialFollowupTemplate } from "./followup-delivery";

const now = new Date("2026-09-15T12:00:00Z");
describe("follow-up: janela e fallback oficial", () => {
  it.each([
    ["waha", null, false], ["waha", "2026-09-01T12:00:00Z", false],
    ["meta_cloud", "2026-09-15T11:00:00Z", false], ["meta_cloud", "2026-09-01T12:00:00Z", true],
    ["meta_cloud", null, true], ["zernio", null, true],
  ] as const)("%s / %s precisa template=%s", (provider, at, expected) => {
    expect(followupNeedsTemplate(provider, at, now)).toBe(expected);
  });
  it("inbound novo reabre; o template enviado não participa do cálculo", () => {
    expect(followupNeedsTemplate("meta_cloud", null, now)).toBe(true);
    expect(followupNeedsTemplate("meta_cloud", now, now)).toBe(false);
  });
});

const definition = {
  id: "template-1", organization_id: "org-1", channel_session_id: "session-1",
  name: "retorno", language: "pt_BR", status: "APPROVED", parameter_format: "POSITIONAL",
  components: [{ type: "BODY", text: "Olá {{1}}!" }],
};
function fakeDb(row: Record<string, unknown> = definition, failure = false) {
  const filters: Array<[string, unknown]> = [];
  const q = { select: () => q,
    eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
    maybeSingle: async () => ({ data: filters.every(([k, v]) => row[k] === v) ? row : null,
      error: failure ? { message: "db error" } : null }),
  };
  return { from: (table: string) => { expect(table).toBe("meta_templates"); return q; } } as unknown as SupabaseClient;
}

describe("fallback usa o contrato existente do template", () => {
  it("renderiza para os gates e preserva nome/idioma/valores para o transporte", async () => {
    expect(await loadOfficialFollowupTemplate(fakeDb(), "org-1", "session-1", "template-1", { "1": "Ana" })).toEqual({
      body: "Olá Ana!", template: { name: "retorno", language: "pt_BR", values: { "1": "Ana" } },
    });
  });
  it("sem fallback informa bloqueio de janela", async () => {
    await expect(loadOfficialFollowupTemplate(fakeDb(), "org-1", "session-1", undefined)).rejects.toThrow("messaging_window_closed");
  });
  it.each([{ organization_id: "org-2" }, { channel_session_id: "session-2" }, { id: "other" }])(
    "recusa definição fora do escopo %j", async (over) => {
      await expect(loadOfficialFollowupTemplate(fakeDb({ ...definition, ...over }), "org-1", "session-1", "template-1"))
        .rejects.toThrow("followup_template_not_found");
    },
  );
  it("recusa template pendente e falha de consulta", async () => {
    await expect(loadOfficialFollowupTemplate(fakeDb({ ...definition, status: "PENDING" }), "org-1", "session-1", "template-1"))
      .rejects.toThrow("followup_template_not_approved");
    await expect(loadOfficialFollowupTemplate(fakeDb(definition, true), "org-1", "session-1", "template-1"))
      .rejects.toThrow("followup_template_lookup_failed");
  });
  it("não envia quando faltam parâmetros", async () => {
    await expect(loadOfficialFollowupTemplate(fakeDb(), "org-1", "session-1", "template-1"))
      .rejects.toThrow("followup_template_missing_values");
  });
});
