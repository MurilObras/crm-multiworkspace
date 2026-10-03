import { describe, expect, it } from "vitest";

import { authCookieOptions } from "./auth-cookie-options";

describe("cookies da confirmação por e-mail", () => {
  it("envia apenas o verificador PKCE na volta de outro site", () => {
    const session = { sameSite: "strict" as const, httpOnly: true, secure: true, path: "/" };

    for (const name of [
      "sb-deskcomm-auth-code-verifier",
      "sb-deskcomm-auth-flows-code-verifier",
      "sb-deskcomm-auth-flow-abcdefghijkl-code-verifier",
      "sb-deskcomm-auth-flow-abcdefghijkl-code-verifier.0",
    ]) {
      expect(authCookieOptions(name, session)).toEqual({ ...session, sameSite: "lax" });
    }
    expect(authCookieOptions("sb-deskcomm-auth", session)).toBe(session);
    expect(authCookieOptions("sb-deskcomm-auth.0", session)).toBe(session);
  });
});
