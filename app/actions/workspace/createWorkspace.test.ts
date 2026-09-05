import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAuth } from "@/lib/auth/server";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/auth/rate-limit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  authRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: vi.fn(() => false) }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "dono@exemplo.com.br" };
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Monta o admin client de dublê e captura os payloads inseridos + deleções. */
function adminClient(orgId: string, opts: { falhaMembership?: boolean } = {}) {
  const inseridos: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const deletados: Array<{ table: string; id: string }> = [];
  const from = (table: string) => ({
    insert: (payload: Record<string, unknown>) => {
      inseridos.push({ table, payload });
      if (table === "organizations") {
        return {
          select: () => ({
            single: async () => ({ data: { id: orgId, slug: payload.slug }, error: null }),
          }),
        };
      }
      if (table === "user_organizations" && opts.falhaMembership) {
        return Promise.resolve({ error: { code: "23502", message: "boom" } });
      }
      return Promise.resolve({ error: null });
    },
    delete: () => ({
      eq: (_col: string, id: string) => {
        deletados.push({ table, id });
        return Promise.resolve({ error: null });
      },
    }),
  });
  return { from, inseridos, deletados };
}

describe("createWorkspace", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue(USUARIO as never);
    vi.mocked(authRateLimited).mockResolvedValue(false);
    const store = { set: vi.fn(), get: vi.fn() };
    vi.mocked(cookies).mockResolvedValue(store as never);
  });

  it("⭐ cria um workspace (organização) novo e membership admin, e vai ao onboarding", async () => {
    const { from, inseridos } = adminClient(ORG_ID);
    vi.mocked(createAdminClient).mockReturnValue({ from } as never);
    const { createWorkspace } = await import("./createWorkspace");

    await expect(createWorkspace("Clínica Boa Vista")).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding/welcome",
    );

    const org = inseridos.find((i) => i.table === "organizations");
    const membro = inseridos.find((i) => i.table === "user_organizations");
    expect(org).toBeDefined();
    expect(org!.payload).toMatchObject({
      display_name: "Clínica Boa Vista",
      legal_name: "Clínica Boa Vista",
      status: "active",
      created_by: USUARIO.id,
    });
    expect(org!.payload.slug).toBe("clinica-boa-vista");
    expect(membro).toBeDefined();
    expect(membro!.payload).toMatchObject({ user_id: USUARIO.id, organization_id: ORG_ID, role: "admin" });

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant.created_by_user",
        organizationId: ORG_ID,
        resourceType: "organization",
      }),
    );

    // A org nova vira a ativa (cookie), como quem acabou de criar espera.
    expect(vi.mocked(cookies)).toHaveBeenCalled();
    const setter = vi.mocked(await cookies()).set;
    expect(setter).toHaveBeenCalledWith("active_org", ORG_ID, expect.objectContaining({ path: "/" }));
  });

  it("nome inválido rejeita ANTES de qualquer escrita ou sessão", async () => {
    const { createWorkspace } = await import("./createWorkspace");

    await expect(createWorkspace("x")).resolves.toEqual({ ok: false, error: "validation_error" });
    await expect(createWorkspace("n".repeat(121))).resolves.toEqual({ ok: false, error: "validation_error" });

    expect(requireAuth).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("rate limit entra ANTES da escrita", async () => {
    vi.mocked(authRateLimited).mockResolvedValue(true);
    const { createWorkspace } = await import("./createWorkspace");

    await expect(createWorkspace("Clínica Boa Vista")).resolves.toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("membership que falha NÃO deixa organização órfã (compensação apaga a org)", async () => {
    const { from, deletados } = adminClient(ORG_ID, { falhaMembership: true });
    vi.mocked(createAdminClient).mockReturnValue({ from } as never);
    const { createWorkspace } = await import("./createWorkspace");

    await expect(createWorkspace("Clínica Boa Vista")).rejects.toThrow(
      "membership insert failed",
    );

    // A organização criada antes da falha foi removida — sem vínculo, ela não pode
    // ficar no banco como lixo invisível (RLS impediria qualquer um de se associar).
    expect(deletados).toEqual([{ table: "organizations", id: ORG_ID }]);
  });
});
