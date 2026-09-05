import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookies } from "next/headers";
import { loadAuthUser } from "@/lib/auth/server";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: vi.fn(() => false) }));

const MINHA_ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";

describe("setActiveOrg", () => {
  let set: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    set = vi.fn();
    vi.mocked(cookies).mockResolvedValue({ set, get: vi.fn() } as never);
  });

  it("⭐ sem membership na org alvo, um usuário comum é barrado", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: "u1",
      is_platform_admin: false,
      organizations: [{ organization_id: MINHA_ORG }],
    } as never);
    const { setActiveOrg } = await import("./setActiveOrg");

    await expect(setActiveOrg(OUTRA_ORG)).resolves.toEqual({ ok: false, error: "forbidden" });
    expect(set).not.toHaveBeenCalled();
  });

  it("⭐ com membership, troca a org ativa gravando o cookie", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: "u1",
      is_platform_admin: false,
      organizations: [{ organization_id: MINHA_ORG }, { organization_id: OUTRA_ORG }],
    } as never);
    const { setActiveOrg } = await import("./setActiveOrg");

    await expect(setActiveOrg(OUTRA_ORG)).resolves.toEqual({ ok: true });
    expect(set).toHaveBeenCalledWith("active_org", OUTRA_ORG, expect.objectContaining({ path: "/" }));
  });

  it("platform admin alcança qualquer org", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: "u1",
      is_platform_admin: true,
      organizations: [{ organization_id: MINHA_ORG }],
    } as never);
    const { setActiveOrg } = await import("./setActiveOrg");

    await expect(setActiveOrg(OUTRA_ORG)).resolves.toEqual({ ok: true });
    expect(set).toHaveBeenCalledWith("active_org", OUTRA_ORG, expect.objectContaining({ path: "/" }));
  });

  it("sem sessão, não grava cookie", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    const { setActiveOrg } = await import("./setActiveOrg");

    await expect(setActiveOrg(MINHA_ORG)).resolves.toEqual({ ok: false, error: "auth_required" });
    expect(set).not.toHaveBeenCalled();
  });
});
