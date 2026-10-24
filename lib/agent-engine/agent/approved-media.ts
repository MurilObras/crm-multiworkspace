/** URLs de arquivo vêm das instruções publicadas ou de material consultado,
 * nunca da conversa do lead. A autorização é por URL exata, não por domínio.
 */
export function collectApprovedMediaUrls(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>"'`\)\]\}]+/g)].map((match) =>
    match[0].replace(/[.,;!?]+$/, ""),
  );
}

/** Links comerciais continuam permitidos. Arquivo de mídia/link de exibição
 * não é alternativa para um veto do catálogo gerenciado. */
export function containsMediaLink(text: string): boolean {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`\)\]\}]+/g)].some((match) => {
    try {
      const url = new URL(match[0].replace(/[.,;!?]+$/, ""));
      const host = url.hostname.toLowerCase();
      const path = decodeURIComponent(url.pathname);
      return (
        /\.(?:mp3|mp4|m4a|aac|ogg|opus|wav|webm|mov|jpe?g|png|gif|webp)$/i.test(path) ||
        /\/storage\/v1\/object\/(?:public|sign)\/whatsapp-media\//i.test(path) ||
        ["youtube.com", "youtu.be", "vimeo.com"].some(
          (domain) => host === domain || host.endsWith(`.${domain}`),
        )
      );
    } catch {
      return false;
    }
  });
}
