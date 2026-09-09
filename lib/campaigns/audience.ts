import { CSV_MAX_DATA_ROWS, mapHeader, normalizaTelefone } from "@/lib/contacts/csv";

export type AudienceContact = { phone_number: string; name?: string };
export type AudiencePreview = {
  total: number; valid: number; unique: number; duplicates: number; invalid: number;
  contacts: AudienceContact[];
};

export function previewAudience(input: string | string[][]): AudiencePreview {
  let rows: string[][];
  let phoneIndex = 0;
  let nameIndex: number | undefined;
  if (typeof input === "string") {
    rows = input.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean).map((s) => [s]);
  } else {
    const { indices } = mapHeader(input[0] ?? []);
    if (indices.phone_number === undefined) throw new Error("A planilha precisa da coluna telefone; nome e opcional.");
    phoneIndex = indices.phone_number;
    nameIndex = indices.name;
    rows = input.slice(1).filter((row) => row.some((cell) => cell.trim()));
  }
  if (rows.length > CSV_MAX_DATA_ROWS) throw new Error(`Maximo de ${CSV_MAX_DATA_ROWS} linhas por publico.`);
  const contacts = new Map<string, AudienceContact>();
  let invalid = 0;
  let duplicates = 0;
  for (const row of rows) {
    const phone = normalizaTelefone(row[phoneIndex] ?? "");
    if (!phone) { invalid++; continue; }
    if (contacts.has(phone)) { duplicates++; continue; }
    const name = nameIndex === undefined ? "" : (row[nameIndex] ?? "").trim().slice(0, 200);
    contacts.set(phone, { phone_number: phone, ...(name ? { name } : {}) });
  }
  return { total: rows.length, valid: rows.length - invalid, unique: contacts.size,
    duplicates, invalid, contacts: [...contacts.values()] };
}
