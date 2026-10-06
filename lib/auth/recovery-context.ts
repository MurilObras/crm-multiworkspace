import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { env } from "@/lib/env";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const RECOVERY_CONTEXT_COOKIE = "crm-recovery-context";
const RECOVERY_TTL_SECONDS = 15 * 60;
const payloadSchema = z.object({ userId: z.string().uuid(), expiresAt: z.number().int() });

function signature(body: string): Buffer {
  return createHmac("sha256", env.INTERNAL_SECRET)
    .update("recovery-context-v1:")
    .update(body)
    .digest();
}

export function signRecoveryContext(userId: string, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ userId, expiresAt: Math.floor(now / 1000) + RECOVERY_TTL_SECONDS }),
  ).toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}

export function verifyRecoveryContext(value: string | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const [body, encodedSignature, extra] = value.split(".");
  if (!body || !encodedSignature || extra) return null;
  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = signature(body);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.expiresAt <= Math.floor(now / 1000)) return null;
    return parsed.data.userId;
  } catch {
    return null;
  }
}

export function recoveryCookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "strict" as const,
    path: "/",
    maxAge: RECOVERY_TTL_SECONDS,
  };
}
