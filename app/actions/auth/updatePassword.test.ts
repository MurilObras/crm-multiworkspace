import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo-de-teste-longo", NEXT_PUBLIC_APP_URL: "https://crm.exemplo.test" },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { signRecoveryContext, RECOVERY_CONTEXT_COOKIE } from "@/lib/auth/recovery-context";
import { updatePassword } from "./updatePassword";

const OUTLOOK = "b2505f7d-efc1-4852-bd05-f4d230d7c30e";
const GMAIL = "d6a0e19a-0b5c-4fd8-b3fd-faa1895a095e";
const updateUser = vi.fn(async () => ({ error: null }));
const signOut = vi.fn(async () => ({ error: null }));
const deleteCookie = vi.fn();
const input = { password: "SenhaForte#2026", password_confirm: "SenhaForte#2026" };

describe("updatePassword — conta verificada pelo link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: OUTLOOK } } })),
        mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } })) },
        updateUser,
        signOut,
      },
    } as never);
  });

  it("não altera Outlook quando o link confirmou Gmail", async () => {
    vi.mocked(cookies).mockResolvedValue({
      get: () => ({ value: signRecoveryContext(GMAIL) }),
      delete: deleteCookie,
    } as never);

    expect(await updatePassword(input)).toEqual({ ok: false, error: "session_expired" });
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("altera apenas a conta da sessão que corresponde ao link", async () => {
    vi.mocked(cookies).mockResolvedValue({
      get: (name: string) => name === RECOVERY_CONTEXT_COOKIE
        ? { value: signRecoveryContext(OUTLOOK) }
        : undefined,
      delete: deleteCookie,
    } as never);

    await updatePassword(input);
    expect(updateUser).toHaveBeenCalledWith({ password: input.password });
    expect(deleteCookie).toHaveBeenCalledWith(RECOVERY_CONTEXT_COOKIE);
    expect(signOut).toHaveBeenCalledOnce();
  });
});
