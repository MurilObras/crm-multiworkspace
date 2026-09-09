import { randomUUID } from "node:crypto";
import { readSheet } from "read-excel-file/node";
import { unzipSync } from "fflate";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { CSV_MAX_BYTES, decodificarCsv, parseCsv } from "@/lib/contacts/csv";
import { previewAudience } from "@/lib/campaigns/audience";

export async function POST(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "contacts" });
  if (!auth.ok) return auth.response;
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const parsed = z.object({ text: z.string().max(CSV_MAX_BYTES) }).strict().safeParse(await req.json());
      if (!parsed.success) return fail("validation_failed", "Lista invalida.", 422, { requestId });
      return ok(previewAudience(parsed.data.text), { requestId });
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !/\.(csv|xlsx)$/i.test(file.name)) {
      return fail("validation_failed", "Envie um arquivo .csv ou .xlsx.", 422, { requestId });
    }
    if (file.size > CSV_MAX_BYTES) return fail("validation_failed", "Arquivo maior que 5 MB.", 413, { requestId });
    const bytes = await file.arrayBuffer();
    let rows: string[][];
    if (/\.xlsx$/i.test(file.name)) {
      // Confere o diretorio ZIP sem descomprimir: 5 MB comprimidos podem ser GB de XML.
      let expanded = 0;
      let entries = 0;
      unzipSync(new Uint8Array(bytes), { filter: (entry) => {
        expanded += entry.originalSize; entries++;
        if (expanded > CSV_MAX_BYTES * 5 || entries > 1000) throw new Error("xlsx_too_large");
        return false;
      } });
      const sheets = await readSheet(Buffer.from(bytes), 1);
      rows = sheets.map((row) => row.map((cell) => cell === null ? "" : String(cell)));
    } else {
      const decoded = decodificarCsv(bytes);
      if ("erro" in decoded) return fail("validation_failed", decoded.erro, 422, { requestId });
      rows = parseCsv(decoded.texto);
    }
    return ok(previewAudience(rows), { requestId });
  } catch {
    return fail("validation_failed", "Confira o arquivo: coluna telefone obrigatoria, nome opcional e ate 500 linhas.", 422, { requestId });
  }
}
