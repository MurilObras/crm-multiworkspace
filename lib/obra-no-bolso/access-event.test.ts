import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateAccessEvent, verifyAccessSignature } from "./access-event";

const now = Date.parse("2026-10-05T18:00:00.000Z");
function event(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, event_type: "first_access_granted", event_id: "evt_1",
    product_user_id: "user_1", occurred_at: "2026-10-05T17:59:00.000Z",
    user_created_at: "2026-10-05T17:30:00.000Z", name: "Pessoa de teste",
    email: "test@example.invalid", phone: "11 99876-5432", plan: "Pro",
    modality: "trial", user_status: "active", is_new_user: true,
    trial_active: true, trial_ends_at: "2026-10-12T18:00:00.000Z", provider: "stripe",
    ...overrides,
  };
}

describe("contrato Obra no Bolso", () => {
  it("aceita trial Stripe ativo com término futuro e telefone canônico", () => {
    const result = validateAccessEvent(event(), now);
    expect(result).toMatchObject({ ok: true, event: { modality: "trial", phone: "+5511998765432" } });
  });
  it("aceita usuário novo Asaas ativo como paid, sem rotular de teste grátis", () => {
    const result = validateAccessEvent(event({ modality: "paid", provider: "asaas", trial_active: false,
      trial_ends_at: null }), now);
    expect(result).toMatchObject({ ok: true, event: { modality: "paid", provider: "asaas" } });
  });
  it("rejeita usuário Asaas antigo", () => {
    expect(validateAccessEvent(event({ modality: "paid", provider: "asaas", is_new_user: false,
      trial_active: false, trial_ends_at: null }), now)).toMatchObject({ ok: false, reason: "paid_user_not_eligible" });
  });
  it("rejeita trial vencido ou inativo", () => {
    expect(validateAccessEvent(event({ trial_ends_at: "2026-10-05T17:00:00.000Z" }), now))
      .toMatchObject({ ok: false, reason: "trial_not_active" });
    expect(validateAccessEvent(event({ trial_active: false }), now))
      .toMatchObject({ ok: false, reason: "trial_not_active" });
  });
  it("mantém telefone sem correspondência como pendência de conciliação", () => {
    expect(validateAccessEvent(event({ phone: "sem telefone" }), now))
      .toMatchObject({ ok: true, phoneVariants: [] });
  });
  it("rejeita dados de cartão e versões desconhecidas", () => {
    expect(validateAccessEvent(event({ card_number: "4111111111111111" }), now))
      .toMatchObject({ ok: false, reason: "invalid_payload" });
    expect(validateAccessEvent(event({ version: 2 }), now))
      .toMatchObject({ ok: false, reason: "invalid_payload" });
  });
  it("aceita somente assinatura HMAC válida do corpo e timestamp recentes", () => {
    const raw = Buffer.from(JSON.stringify(event()));
    const stamp = String(Math.floor(now / 1000));
    const secret = "synthetic-secret";
    const signature = `v1=${createHmac("sha256", secret).update(stamp).update(".").update(raw).digest("hex")}`;
    expect(verifyAccessSignature(raw, stamp, signature, secret, now)).toBe(true);
    expect(verifyAccessSignature(Buffer.from("{}"), stamp, signature, secret, now)).toBe(false);
    expect(verifyAccessSignature(raw, stamp, signature, "wrong", now)).toBe(false);
    expect(verifyAccessSignature(raw, String(Math.floor(now / 1000) - 600), signature, secret, now)).toBe(false);
    expect(verifyAccessSignature(raw, stamp, null, secret, now)).toBe(false);
  });
});
