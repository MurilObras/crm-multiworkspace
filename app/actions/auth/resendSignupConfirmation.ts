"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";

export async function resendSignupConfirmation(
  input: ForgotPasswordInput,
): Promise<{ ok: true } | { ok: false; error: "validation_error" | "rate_limited" | "send_failed" }> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_error" };

  const hdrs = await headers();
  if (await authRateLimited("signup_confirmation", parsed.data.email, AUTH_LIMITS.reset)) {
    return { ok: false, error: "rate_limited" };
  }

  const origin = hdrs.get("origin") ?? env.NEXT_PUBLIC_APP_URL;
  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: { emailRedirectTo: `${origin}/auth/confirm?type=signup` },
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };
    await audit({
      action: "auth.signup_confirmation_failed",
      metadata: { email_hash: hashEmail(parsed.data.email), reason: error.message },
      requestId: hdrs.get("x-request-id"),
    });
    return { ok: false, error: "send_failed" };
  }

  await audit({
    action: "auth.signup_confirmation_requested",
    metadata: { email_hash: hashEmail(parsed.data.email) },
    requestId: hdrs.get("x-request-id"),
  });
  // Resposta neutra: não confirma se a conta existe.
  return { ok: true };
}
