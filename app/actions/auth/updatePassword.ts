"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { audit } from "@/lib/audit";
import { RECOVERY_CONTEXT_COOKIE, verifyRecoveryContext } from "@/lib/auth/recovery-context";

export type UpdatePasswordResult = {
  ok: false;
  error:
    | "validation_error"
    | "session_expired"
    | "same_password"
    | "update_failed"
    | "mfa_required"
    | "mfa_invalid";
  details?: Record<string, unknown>;
};

/**
 * Define a nova senha dentro da sessão de recovery (estabelecida pelo link do
 * e-mail via /auth/confirm). Ao concluir, encerra a sessão e redireciona para
 * /login?reset=success — o usuário prova a senha nova num login limpo.
 */
export async function updatePassword(
  input: ResetPasswordInput,
): Promise<UpdatePasswordResult> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "session_expired" };

  const cookieStore = await cookies();
  const recoveryUserId = verifyRecoveryContext(cookieStore.get(RECOVERY_CONTEXT_COOKIE)?.value);
  if (!recoveryUserId) return { ok: false, error: "session_expired" };
  if (recoveryUserId !== user.id) {
    await audit({
      action: "auth.password_reset_failed",
      actorUserId: user.id,
      metadata: { reason: "recovery_user_mismatch" },
    });
    return { ok: false, error: "session_expired" };
  }

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Conta com MFA: a sessão de recovery entra em AAL1, mas o GoTrue recusa a
  // troca de senha em AAL1 quando há fator verificado ("AAL2 session is
  // required..."). Elevamos para AAL2 com um challenge TOTP antes do update.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2") {
    if (!parsed.data.mfa_code) return { ok: false, error: "mfa_required" };
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const totp = factors?.totp?.[0];
    if (!totp) return { ok: false, error: "update_failed" };
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
      factorId: totp.id,
    });
    if (chErr || !challenge) return { ok: false, error: "mfa_invalid" };
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId: totp.id,
      challengeId: challenge.id,
      code: parsed.data.mfa_code,
    });
    if (verifyErr) return { ok: false, error: "mfa_invalid" };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    if (/different from the old password/i.test(error.message)) {
      return { ok: false, error: "same_password" };
    }
    await audit({
      action: "auth.password_reset_failed",
      actorUserId: user.id,
      metadata: { reason: error.message },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "update_failed" };
  }

  await audit({
    action: "auth.password_reset_completed",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  cookieStore.delete(RECOVERY_CONTEXT_COOKIE);
  await supabase.auth.signOut();
  redirect("/login?reset=success");
}
