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
