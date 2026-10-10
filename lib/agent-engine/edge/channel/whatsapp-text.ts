/** Converte negrito Markdown para WhatsApp sem alterar URLs ou trechos de código. */
export function formatWhatsAppText(body: string): string {
  return body
    .split(/(```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s]+)/g)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")))
    .join("");
}
