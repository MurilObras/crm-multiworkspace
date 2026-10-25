export const temporaryMediaPreference = (text: string) => {
  const s = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  // Só expira automaticamente quando o próprio cliente limita a UMA resposta.
  // “Hoje”, “por enquanto” e “a partir de agora” continuam até mudança clara.
  return /\b(?:nesta|nessa|esta|essa)\s+(?:resposta|mensagem|vez)\b|\b(?:desta|dessa) vez\b/.test(
    s,
  );
};

export const mediaPreferenceClauses = (text: string) =>
  text.split(/\b(?:mas|por[eé]m|but|pero)\b|[.;\n]/iu);

const temporaryPreferenceIntro = (text: string) =>
  /^\s*(?:(?:nesta|nessa|esta|essa)\s+(?:resposta|mensagem|vez)|(?:desta|dessa) vez)\s*[:,]?\s*(?:por favor\s*)?[:\s]*$/iu.test(
    text,
  );

/** Uma exceção em outra oração não apaga uma preferência geral da mesma inbound. */
export function durableMediaPreference(
  text: string,
  parse: (clause: string) => "text" | "audio" | null,
): "text" | "audio" | null {
  let durable: "text" | "audio" | null = null;
  let pendingTemporary = false;
  for (const clause of mediaPreferenceClauses(text)) {
    const temporary = temporaryMediaPreference(clause) || pendingTemporary;
    const preference = parse(clause);
    // Preserva também um introdutor separado por quebra: "Nesta resposta:\nSó texto".
    pendingTemporary =
      preference === null &&
      (temporaryPreferenceIntro(clause) || (pendingTemporary && !clause.trim()));
    if (preference !== null && !temporary) durable = preference;
  }
  return durable;
}
