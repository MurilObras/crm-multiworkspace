import type { CookieOptions } from "@supabase/ssr";

const PKCE_SUFFIX = /^(?:code-verifier|flows-code-verifier|flow-[A-Za-z0-9_-]{8,64}-code-verifier)(?:\.\d+)?$/;

/**
 * O link do e-mail padrão do Supabase volta de outro site com `code` (PKCE).
 * Só o verificador precisa viajar nessa navegação GET. A sessão continua
 * SameSite=Strict e HttpOnly.
 */
export function authCookieOptions(name: string, options: CookieOptions, storageKey: string): CookieOptions {
  const prefix = `${storageKey}-`;
  if (!name.startsWith(prefix) || !PKCE_SUFFIX.test(name.slice(prefix.length))) return options;
  return { ...options, sameSite: "lax" };
}
