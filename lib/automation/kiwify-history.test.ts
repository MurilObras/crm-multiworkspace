import { describe, expect, it } from "vitest";
import { canSendManually } from "./kiwify-history";

const base = {
  intake_status: "accepted",
  contact_id: "contact",
  current_phone: "+12025550102",
  contact_blocked: false,
};

describe("canSendManually", () => {
  it("aceita compra válida com contato, telefone e não bloqueado", () => {
    expect(canSendManually(base)).toBe(true);
  });
  it("recusa entrada não aceita (recusada / sem telefone / ignorada)", () => {
    expect(canSendManually({ ...base, intake_status: "accepted_no_phone" })).toBe(false);
    expect(canSendManually({ ...base, intake_status: "ignored" })).toBe(false);
    expect(canSendManually({ ...base, intake_status: "invalid" })).toBe(false);
  });
  it("recusa contato ausente ou sem telefone (anonimizado chega assim)", () => {
    expect(canSendManually({ ...base, contact_id: null })).toBe(false);
    expect(canSendManually({ ...base, current_phone: null })).toBe(false);
  });
  it("recusa contato bloqueado", () => {
    expect(canSendManually({ ...base, contact_blocked: true })).toBe(false);
  });
});
