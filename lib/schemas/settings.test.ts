import { describe, it, expect } from "vitest";

import {
  profileSchema,
  tenantSchema,
  notificationPrefsSchema,
  pipelineConfigPatchSchema,
} from "./settings";

describe("profileSchema", () => {
  it("accepts pt-BR locale + valid timezone", () => {
    const r = profileSchema.safeParse({
      full_name: "Rafael",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      avatar_url: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown locale", () => {
    const r = profileSchema.safeParse({
      full_name: "x",
      locale: "fr-FR",
      timezone: "America/Sao_Paulo",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid avatar_url", () => {
    const r = profileSchema.safeParse({
      locale: "pt-BR",
      timezone: "UTC",
      avatar_url: "not a url",
    });
    expect(r.success).toBe(false);
  });

  it("coerces empty avatar_url to null", () => {
    const r = profileSchema.safeParse({
      locale: "pt-BR",
      timezone: "UTC",
      avatar_url: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.avatar_url).toBeNull();
  });
});

describe("tenantSchema", () => {
  it("accepts a minimal valid tenant payload", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme LTDA",
      cnpj: "12345678000190",
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      currency: "BRL",
      media_retention_days: 90,
      dpo_email: "dpo@acme.com",
      privacy_policy_url: "https://acme.com/privacy",
      lost_reasons_extra: ["Sem orçamento"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects too-low retention", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme",
      timezone: "UTC",
      locale: "pt-BR",
      media_retention_days: 5,
      lost_reasons_extra: [],
    });
    expect(r.success).toBe(false);
  });

  it("defaults lost_reasons_extra to empty array", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme",
      timezone: "UTC",
      locale: "pt-BR",
      currency: "BRL",
      media_retention_days: 90,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lost_reasons_extra).toEqual([]);
  });

  /**
   * ⚠️ `currency` e OBRIGATORIA de proposito, e o contrario seria pior.
   *
   * Com `.default("BRL")`, qualquer salvamento que omitisse o campo — um
   * chamador novo, um payload montado a mao — PISARIA a moeda de uma
   * organizacao mexicana em silencio, porque a action grava a linha inteira.
   * Sao dois chamadores conhecidos (o formulario e a propria action), os dois
   * mandam o campo, e quem esquecer falha ALTO em vez de trocar a unidade do
   * catalogo sem avisar.
   */
  it("exige a moeda em vez de assumir uma", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme",
      timezone: "UTC",
      locale: "pt-BR",
      media_retention_days: 90,
    });
    expect(r.success).toBe(false);
  });
});

describe("notificationPrefsSchema", () => {
  it("accepts a list of category/channel/enabled tuples", () => {
    const r = notificationPrefsSchema.safeParse({
      prefs: [{ category: "lead_assigned", channel: "email", enabled: true }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown category", () => {
    const r = notificationPrefsSchema.safeParse({
      prefs: [{ category: "bogus", channel: "email", enabled: true }],
    });
    expect(r.success).toBe(false);
  });
});

describe("pipelineConfigPatchSchema", () => {
  it("accepts partial vocabulary patch", () => {
    const r = pipelineConfigPatchSchema.safeParse({
      vocabulary: { lead: "Cliente", won: "Pago" },
    });
    expect(r.success).toBe(true);
  });

  it("validates field key shape", () => {
    const r = pipelineConfigPatchSchema.safeParse({
      fields: [{ key: "1bad", label: "x", type: "text" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts well-formed fields", () => {
    const r = pipelineConfigPatchSchema.safeParse({
      fields: [{ key: "size", label: "Tamanho", type: "text" }],
      lost_reasons: ["Concorrente", "Preço"],
    });
    expect(r.success).toBe(true);
  });
});

/**
 * ─── Campos jurídicos opcionais (workspace) ───────────────────────────────
 *
 * Workspace = nome de produto de `organizations`. Para uso interno a razão
 * social é irrelevante, então ela virou opcional na tela — com fallback para o
 * nome de exibição no próprio schema, mantendo a coluna `legal_name` do banco
 * `NOT NULL` sem migration. Estes casos só ACRESCENTAM à suíte de cima.
 */
describe("tenantSchema — campos jurídicos opcionais", () => {
  const BASE = {
    display_name: "Time Comercial",
    timezone: "America/Sao_Paulo",
    locale: "pt-BR",
    currency: "BRL",
    media_retention_days: 365,
  };

  it("legal_name vazio cai para o nome de exibição (a coluna continua NOT NULL no banco)", () => {
    const r = tenantSchema.safeParse({ ...BASE, legal_name: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.legal_name).toBe("Time Comercial");
  });

  it("legal_name ausente (undefined) também cai para o nome de exibição", () => {
    const r = tenantSchema.safeParse({ ...BASE });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.legal_name).toBe("Time Comercial");
  });

  it("legal_name informado é preservado (uso com CNPJ/LGPD formal)", () => {
    const r = tenantSchema.safeParse({ ...BASE, legal_name: "Clínica Boa Vista Ltda" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.legal_name).toBe("Clínica Boa Vista Ltda");
  });

  it("cnpj e dpo_email são opcionais (null é aceito)", () => {
    const r = tenantSchema.safeParse({ ...BASE, cnpj: null, dpo_email: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cnpj).toBeNull();
      expect(r.data.dpo_email).toBeNull();
      // O fallback da razão social não é afetado por campos jurídicos ausentes.
      expect(r.data.legal_name).toBe("Time Comercial");
    }
  });
});
