import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/confirm — troca o token do e-mail por uma sessão.
 *
 * É o destino único dos links de e-mail do GoTrue: confirmação de signup E
 * redefinição de senha. Dois formatos de link chegam aqui, dependendo de como
 * o projeto Supabase está configurado:
 *
 * - `token_hash` + `type`: template de e-mail customizado (supabase/templates/,
 *   subidos por `hostgator-setup-kit/marca-emails.sh`) linkando direto pro app.
 *   No projeto gratuito com remetente padrão, o Supabase recusou atualizar
 *   esses modelos em 2026-10-03 (HTTP 400: exige SMTP próprio ou upgrade).
 *   O suporte ao formato `code` abaixo permite confirmação no mesmo navegador
 *   até que os modelos com `token_hash` possam ser configurados.
 * - `code` (PKCE): template PADRÃO do Supabase (o de quem nunca configurou os
 *   templates — caso mais comum em instalação fresca). O e-mail linka pro
 *   `/auth/v1/verify` do próprio GoTrue, que valida e SÓ ENTÃO redireciona pra
 *   cá com o code; não inclui `type`, por isso requestPasswordReset.ts e
 *   signUp.ts anexam `?type=` no redirectTo/emailRedirectTo — é o único jeito
 *   desse dado sobreviver ao hop pelo GoTrue nesse formato.
 *
 *   O formato `code` exige o verificador PKCE no MESMO navegador que pediu o
 *   e-mail. Apenas esse cookie usa SameSite=Lax (`lib/supabase/server.ts`),
 *   para viajar na volta cross-site do webmail; a sessão segue Strict. Se o
 *   link abrir em outro navegador/dispositivo, não há verificador e a troca
 *   falha. O formato `token_hash` não depende desse cookie.
 *
 *   A recusa dos dois ramos não tem a mesma mensagem: em `code`, a causa
 *   frequente é a ausência do cookie PKCE no navegador de retorno.
 *
 * - type=signup  → provisiona o tenant (org + membership admin) e entra no
 *                  onboarding. Provisionamento é idempotente (link clicado 2x).
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 *
 * Fluxo canônico do @supabase/ssr: verifyOtp/exchangeCodeForSession grava os
 * cookies de sessão via cookies() do next/headers; o Next anexa os Set-Cookie
 * ao redirect retornado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestId = request.headers.get("x-request-id");

  // NUNCA usar url.origin aqui: é derivado do header Host, que o proxy/container
  // pode entregar como o bind interno (ex.: 0.0.0.0:3000) em vez do domínio
  // público — o link de recovery quebra silenciosamente para o usuário final.
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  if (!(tokenHash && type) && !code) {
    return redirectTo("/login?error=link_invalido");
  }

  // Qual dos dois formatos chegou é um FATO observável, não inferência: o
  // `code` só existe no link que o template PADRÃO do Supabase monta. Guardar
  // isso antes da chamada é o que permite explicar a recusa depois.
  const viaTokenHash = Boolean(tokenHash && type);

  const supabase = await createClient();
  const { data, error } =
    tokenHash && type
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code as string);

  if (error || !data.user) {
    await audit({
      action: "auth.email_link_rejected",
      // `formato` é o campo que faltava: sem ele os dois modos de falha
      // chegavam ao audit log indistinguíveis, e a triagem de "o link não
      // funciona" começava do zero toda vez.
      metadata: { type, formato: viaTokenHash ? "token_hash" : "code", reason: error?.message ?? "no_user" },
      requestId,
    });
    // No formato code, a ausência do verificador PKCE é comum quando o e-mail
    // abre em outro navegador ou dispositivo.
    return redirectTo(viaTokenHash ? "/login?error=link_invalido" : "/login?error=template_padrao");
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  // Foi convidado? Então NÃO ganha organização própria. Sem esta bifurcação,
  // quem clica no link do convite sem ter conta cria uma, cai aqui sem vínculo
  // nenhum, e `ensureTenantForUser` faz o que faria com qualquer visitante:
  // abre uma empresa e o torna admin dela. A pessoa fica com uma organização
  // fantasma, um wizard que não é dela e o gate de MFA de administrador.
  const decisao = decidirConviteDoSignup(data.user);

  if (decisao.tipo === "recusar") {
    // Falha FECHADA: havia convite e ele não vale (expirado ou de outra pessoa).
    // Provisionar aqui seria devolver o defeito com um conserto por cima.
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: data.user.id,
      metadata: { motivo: decisao.motivo },
      requestId,
    });
    return redirectTo("/login?error=convite_invalido");
  }

  if (decisao.tipo === "convite") {
    // A sessão já está firmada, então a tela de aceite reconhece o usuário e o
    // clique cai no `acceptInviteAction` que já existe — auditado e idempotente.
    // Nenhuma lógica de membership nova mora aqui.
    return redirectTo(`/team/accept-invite/${decisao.token}`);
  }

  try {
    await ensureTenantForUser(data.user);
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: data.user.id,
      metadata: { reason: e instanceof Error ? e.message : String(e) },
      requestId,
    });
    // A sessão JÁ está firmada (o `verifyOtp`/`exchangeCodeForSession` acima
    // passou). Mandar para `/login` deixava a pessoa logada e sem organização,
    // sem nenhum caminho de volta — ver `app/actions/auth/recoverOrganization.ts`.
    return redirectTo("/get-started");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: data.user.id,
    metadata: {},
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}
