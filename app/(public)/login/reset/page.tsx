import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { RECOVERY_CONTEXT_COOKIE, verifyRecoveryContext } from "@/lib/auth/recovery-context";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Nova senha" };

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);
  const recoveryUserId = verifyRecoveryContext(
    (await cookies()).get(RECOVERY_CONTEXT_COOKIE)?.value,
  );
  const sessionMatchesLink = Boolean(user && recoveryUserId === user.id);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Definir nova senha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Escolha uma nova senha para sua conta")}
        </p>
      </div>
      {sessionMatchesLink ? (
        <ResetPasswordForm />
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          {t("Não foi possível vincular o link à sessão atual. Peça um novo link em Recuperar senha.")} {" "}
          <Link href="/login/forgot" className="underline">
            {t("Recuperar senha")}
          </Link>
        </p>
      )}
    </div>
  );
}
