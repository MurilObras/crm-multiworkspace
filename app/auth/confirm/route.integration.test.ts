// @vitest-environment node
/** Cliente Supabase e cookies reais; apenas o transporte GoTrue é simulado. */
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";

const state = vi.hoisted(() => ({
  cookies: new Map<string, { value: string; options: CookieOptions }>(),
  writes: [] as { name: string; options: CookieOptions }[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...state.cookies].map(([name, item]) => ({ name, value: item.value })),
    set: (name: string, value: string, options: CookieOptions) => {
      state.writes.push({ name, options });
      if (options.maxAge === 0) state.cookies.delete(name);
      else state.cookies.set(name, { value, options });
    },
  }),
}));
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.test",
    NEXT_PUBLIC_SUPABASE_URL: "https://auth.exemplo.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon",
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => undefined) }));

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { signInviteToken } from "@/lib/auth/invite-token";
import { GET } from "./route";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "convidado@example.test",
  user_metadata: {},
};
const pending = new Map<string, string>();
const exchanged: string[] = [];
let metadata: Record<string, unknown> = {};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function session() {
  const payload = Buffer.from(
    JSON.stringify({ sub: USER.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.test`,
    refresh_token: "test-refresh",
    token_type: "bearer",
    expires_in: 3600,
    user: { ...USER, user_metadata: metadata },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.cookies.clear();
  state.writes.length = 0;
  pending.clear();
  exchanged.length = 0;
  metadata = {};
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (["/auth/v1/signup", "/auth/v1/recover", "/auth/v1/resend"].includes(url.pathname)) {
      const redirect = new URL(url.searchParams.get("redirect_to")!);
      pending.set(redirect.searchParams.get("sb_flow_id")!, body.code_challenge);
      if (body.data) metadata = body.data;
      return json(url.pathname.endsWith("signup") ? USER : {});
    }
    if (url.pathname === "/auth/v1/token") {
      exchanged.push(body.auth_code);
      const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
      if (pending.get(body.auth_code) !== challenge) {
        return json({ message: "PKCE challenge mismatch", code: "bad_code_verifier" }, 400);
      }
      pending.delete(body.auth_code);
      return json(session());
    }
    if (url.pathname === "/auth/v1/verify") return json(session());
    throw new Error(`Transporte inesperado no teste: ${url.pathname}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function confirm(flowId: string, type: "signup" | "recovery") {
  return GET(
    new NextRequest(
      `https://crm.exemplo.test/auth/confirm?type=${type}&code=${flowId}&sb_flow_id=${flowId}`,
    ),
  );
}

describe("retorno do e-mail com cliente Supabase real", () => {
  it("confirma o convite mais antigo mesmo depois de solicitar recuperação em outra aba", async () => {
    const invite = signInviteToken({
      invite_id: "invite-1",
      organization_id: "org-1",
      email: USER.email,
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await (
      await createClient()
    ).auth.signUp({
      email: USER.email,
      password: "SenhaForte!123",
      options: {
        emailRedirectTo: "https://crm.exemplo.test/auth/confirm?type=signup",
        data: { invite_token: invite },
      },
    });
    const firstFlow = [...pending.keys()][0]!;
    await (
      await createClient()
    ).auth.resetPasswordForEmail(USER.email, {
      redirectTo: "https://crm.exemplo.test/auth/confirm?type=recovery",
    });
    expect(pending.size).toBe(2);

    // O webmail não envia cookies Strict, só os verificadores Lax.
    for (const [name, item] of state.cookies) {
      expect(name).toContain("code-verifier");
      expect(item.options).toMatchObject({ sameSite: "lax", httpOnly: true, secure: true });
    }
    const response = await confirm(firstFlow, "signup");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`/team/accept-invite/${invite}`);
    expect(ensureTenantForUser).not.toHaveBeenCalled();
    expect(exchanged).toEqual([firstFlow]);
    expect(state.cookies.get("sb-deskcomm-auth")?.options).toMatchObject({
      sameSite: "strict",
      httpOnly: true,
      secure: true,
    });
  });

  it("recuperação segue para definir a senha sem provisionar uma empresa", async () => {
    await (
      await createClient()
    ).auth.resetPasswordForEmail(USER.email, {
      redirectTo: "https://crm.exemplo.test/auth/confirm?type=recovery",
    });
    const response = await confirm([...pending.keys()][0]!, "recovery");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/login/reset");
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("reenvio cria um verificador utilizável no navegador atual", async () => {
    await (
      await createClient()
    ).auth.resend({
      type: "signup",
      email: USER.email,
      options: { emailRedirectTo: "https://crm.exemplo.test/auth/confirm?type=signup" },
    });
    const response = await confirm([...pending.keys()][0]!, "signup");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/onboarding/welcome");
    expect(ensureTenantForUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: USER.email }),
    );
  });

  it("link aberto sem o cookie não confirma nem provisiona", async () => {
    await (
      await createClient()
    ).auth.resetPasswordForEmail(USER.email, {
      redirectTo: "https://crm.exemplo.test/auth/confirm?type=recovery",
    });
    const flow = [...pending.keys()][0]!;
    state.cookies.clear();
    const response = await confirm(flow, "recovery");
    expect(response.headers.get("location")).toBe(
      "https://crm.exemplo.test/login?error=template_padrao",
    );
    expect(exchanged).toEqual([]);
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("o formato token_hash continua funcionando sem cookies de PKCE", async () => {
    const response = await GET(
      new NextRequest("https://crm.exemplo.test/auth/confirm?token_hash=test&type=recovery"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/login/reset");
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("um fluxo ausente é recusado sem consumir o cookie de outro link válido", async () => {
    await (await createClient()).auth.resetPasswordForEmail(USER.email, {
      redirectTo: "https://crm.exemplo.test/auth/confirm?type=recovery",
    });
    const flow = [...pending.keys()][0]!;
    const refused = await GET(new NextRequest(
      `https://crm.exemplo.test/auth/confirm?type=recovery&code=${flow}&sb_flow_id=outrofluxo1234`,
    ));
    expect(refused.status).toBe(307);
    expect(exchanged).toEqual([]);
    const valid = await confirm(flow, "recovery");
    expect(valid.status).toBe(200);
    expect(valid.headers.get("cache-control")).toBe("no-store");
    expect(valid.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("falha no provisionamento conserva a sessão e oferece a recuperação do ambiente", async () => {
    vi.mocked(ensureTenantForUser).mockRejectedValueOnce(new Error("Provisionamento indisponível"));
    const response = await GET(new NextRequest(
      "https://crm.exemplo.test/auth/confirm?token_hash=test&type=signup",
    ));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/get-started");
    expect(state.cookies.get("sb-deskcomm-auth")?.options.sameSite).toBe("strict");
  });
});
