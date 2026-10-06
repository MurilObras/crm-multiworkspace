import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo-de-teste-longo", NEXT_PUBLIC_APP_URL: "https://crm.exemplo.test" },
}));

import { signRecoveryContext, verifyRecoveryContext } from "./recovery-context";

const GMAIL = "d6a0e19a-0b5c-4fd8-b3fd-faa1895a095e";

describe("contexto da recuperação", () => {
  it("vincula a conta confirmada e expira após quinze minutos", () => {
    const now = Date.UTC(2026, 9, 5, 20, 36);
    const token = signRecoveryContext(GMAIL, now);
    expect(verifyRecoveryContext(token, now + 14 * 60_000)).toBe(GMAIL);
    expect(verifyRecoveryContext(token, now + 15 * 60_000)).toBeNull();
  });

  it("recusa cookie adulterado", () => {
    const token = signRecoveryContext(GMAIL);
    expect(verifyRecoveryContext(`${token}x`)).toBeNull();
  });
});
