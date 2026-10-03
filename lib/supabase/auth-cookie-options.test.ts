import { describe, expect, it } from "vitest";

import { authCookieOptions } from "./auth-cookie-options";

describe("cookies da confirmação por e-mail", () => {
  it("envia apenas o verificador PKCE na volta de outro site", () => {
    const session = { sameSite: "strict" as const, httpOnly: true, secure: true, path: "/" };

    for (const name of [
      "test-auth-code-verifier",
      "test-auth-flows-code-verifier",
      "test-auth-flow-abcdefghijkl-code-verifier",
      "test-auth-flow-abcdefghijkl-code-verifier.0",
    ]) {
      expect(authCookieOptions(name, session, "test-auth")).toEqual({ ...session, sameSite: "lax" });
    }
    expect(authCookieOptions("test-auth", session, "test-auth")).toBe(session);
    expect(authCookieOptions("test-auth.0", session, "test-auth")).toBe(session);
    expect(authCookieOptions("other-auth-code-verifier", session, "test-auth")).toBe(session);
  });
});
