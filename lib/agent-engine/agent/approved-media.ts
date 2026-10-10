/** URLs de arquivo vêm das instruções publicadas ou de material consultado,
 * nunca da conversa do lead. A autorização é por URL exata, não por domínio.
 */
export function collectApprovedMediaUrls(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>"'`\)\]\}]+/g)].map((match) =>
    match[0].replace(/[.,;!?]+$/, ""),
  );
}
