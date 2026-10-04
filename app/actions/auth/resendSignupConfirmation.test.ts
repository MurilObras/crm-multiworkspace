import { beforeEach, describe, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
const resend = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  resend.mockResolvedValue({ error: null });
  vi.mocked(headers).mockResolvedValue({
    get: (key: string) => (key === "origin" ? "https://crm.exemplo.test" : null),
  } as never);
  vi.mocked(createClient).mockResolvedValue({ auth: { resend } } as never);
});

describe("reenvio da confirmação", () => {
  it("limita por e-mail mesmo sem IP disponível e não chama o provedor na quarta tentativa", async () => {
    const { resendSignupConfirmation } = await import("./resendSignupConfirmation");
    const results = [];
    for (let count = 0; count < 4; count++)
      results.push(await resendSignupConfirmation({ email: "pendente@example.test" }));
    expect(results).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: false, error: "rate_limited" },
    ]);
    expect(resend).toHaveBeenCalledTimes(3);
    expect(resend).toHaveBeenCalledWith({
      type: "signup",
      email: "pendente@example.test",
      options: { emailRedirectTo: "https://crm.exemplo.test/auth/confirm?type=signup" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signup_confirmation_requested",
        metadata: { email_hash: expect.any(String) },
      }),
    );
  });

  it("recusa endereço inválido antes de tentar enviar", async () => {
    const { resendSignupConfirmation } = await import("./resendSignupConfirmation");
    expect(await resendSignupConfirmation({ email: "inválido" })).toEqual({
      ok: false,
      error: "validation_error",
    });
    expect(resend).not.toHaveBeenCalled();
  });

  it("informa falha de envio e registra o erro sem expor o e-mail na auditoria", async () => {
    const { resendSignupConfirmation } = await import("./resendSignupConfirmation");
    resend.mockResolvedValue({ error: { status: 500, message: "SMTP unavailable" } });
    expect(await resendSignupConfirmation({ email: "pendente@example.test" })).toEqual({
      ok: false,
      error: "send_failed",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signup_confirmation_failed",
        metadata: { email_hash: expect.any(String), reason: "SMTP unavailable" },
      }),
    );
  });
});
