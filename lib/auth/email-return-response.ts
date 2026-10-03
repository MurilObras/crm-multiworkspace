/**
 * Uma resposta 302 vinda do webmail conserva a origem cross-site na cadeia de
 * redirects. Mesmo a sessão recém-gravada com SameSite=Strict não viaja para
 * a próxima tela. Entregar um documento primeiro faz a navegação seguinte
 * nascer no próprio CRM, sem relaxar o cookie da sessão.
 */
export function emailReturnResponse(destination: URL): Response {
  const href = destination.href.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );

  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${href}"><title>Continuar</title></head><body><p>Seu acesso foi confirmado.</p><a href="${href}">Continuar</a></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
