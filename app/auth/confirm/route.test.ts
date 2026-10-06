import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_SECRET: "segredo-de-teste-longo",
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.test",
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { RECOVERY_CONTEXT_COOKIE, verifyRecoveryContext } from "@/lib/auth/recovery-context";
import { GET } from "./route";

const GMAIL = "d6a0e19a-0b5c-4fd8-b3fd-faa1895a095e";

describe("/auth/confirm — recuperação", () => {
  it("vincula o formulário à conta validada e inicia navegação no próprio CRM", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        verifyOtp: vi.fn(async () => ({ data: { user: { id: GMAIL } }, error: null })),
      },
    } as never);

    const response = await GET(new NextRequest(
      "https://crm.exemplo.test/auth/confirm?type=recovery&token_hash=token-de-teste",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('url=/login/reset');
    const cookie = response.cookies.get(RECOVERY_CONTEXT_COOKIE);
    expect(verifyRecoveryContext(cookie?.value)).toBe(GMAIL);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=strict");
  });
});
