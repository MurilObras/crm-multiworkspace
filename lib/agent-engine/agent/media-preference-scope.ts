import type { Queryable } from "../queue/queue";

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

export async function latestTemporaryPreference(
  db: Queryable,
  org: string,
  conversation: string,
  parse: (text: string) => "audio" | "text" | null,
): Promise<"audio" | "text" | null> {
  const { rows } = await db.query<{ body: string | null; media_derived_text: string | null }>(
    `select body,media_derived_text from messages where organization_id=$1 and conversation_id=$2 and direction='inbound'
     order by coalesce(sent_at,created_at) desc,created_at desc,id desc limit 1`,
    [org, conversation],
  );
  const text = [rows[0]?.body, rows[0]?.media_derived_text].filter(Boolean).join("\n");
  return temporaryMediaPreference(text) ? parse(text) : null;
}
