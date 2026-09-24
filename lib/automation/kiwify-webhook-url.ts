/**
 * URL pública do webhook Kiwify, montada do CLIENTE (a mesma origem que o
 * navegador enxerga — é o endereço que a Kiwify precisa chamar de fora, atrás
 * de qualquer proxy/reverso). Aceita tanto o `path_token` cru (GET da integração)
 * quanto o `endpoint` completo devolvido no POST.
 */
export function webhookUrlKiwify(origin: string, tokenOrPath: string): string {
  const path = tokenOrPath.startsWith("/")
    ? tokenOrPath
    : `/api/v1/webhooks/kiwify/${tokenOrPath}`;
  return `${origin.replace(/\/+$/, "")}${path}`;
}
