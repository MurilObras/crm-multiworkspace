/**
 * A elegibilidade do publish de follow-up tem de enxergar o MESMO conjunto de
 * canais que o runtime usa para enviar: só sessões NÃO arquivadas. Um Meta
 * antigo arquivado numa org que hoje só usa WAHA não pode exigir
 * `fallback_template_id` — o follow-up real (`resolveSendTarget`) ignora o
 * arquivado, então o publish que enxergasse o arquivado criaria um falso
 * positivo: exige template de quem só manda texto livre.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DbErrorLike } from "@/lib/channels/archived";
import { orgExigeTemplateForaDaJanela } from "@/lib/channels/exige-template-fora-da-janela";

type Linha = { provider: string | null };
type Resposta = { data: Linha[] | null; error: DbErrorLike | null };

interface Builder {
  select(colunas: string): Builder;
  eq(coluna: string, valor: string): Builder;
  is(coluna: string, valor: null): Builder;
  then(resolve: (v: Resposta) => unknown): Promise<unknown>;
}

/** Client falso que grava a consulta montada — mesmo molde de `canais-selecionaveis.test.ts`. */
function fakeDb(respostas: Resposta[]) {
  const chamadas: string[][] = [];
  let indice = 0;

  const build = (): Builder => {
    const trilha: string[] = [];
    chamadas.push(trilha);
    const b: Builder = {
      select(colunas) {
        trilha.push(`select(${colunas})`);
        return b;
      },
      eq(coluna, valor) {
        trilha.push(`eq(${coluna}=${valor})`);
        return b;
      },
      is(coluna, valor) {
        trilha.push(`is(${coluna}=${String(valor)})`);
        return b;
      },
      then(resolve) {
        const r = respostas[Math.min(indice, respostas.length - 1)];
        indice += 1;
        return Promise.resolve(r as Resposta).then(resolve);
      },
    };
    return b;
  };

  const db = { from: (_tabela: string) => build() };
  return { db: db as unknown as SupabaseClient, chamadas };
}

describe("orgExigeTemplateForaDaJanela", () => {
  it("WAHA não arquivado + Meta arquivado => publish de texto livre permitido (sem fallback)", async () => {
    // O `archived_at is null` faz o banco já devolver só o WAHA vivo.
    const { db, chamadas } = fakeDb([{ data: [{ provider: "waha" }], error: null }]);

    await expect(orgExigeTemplateForaDaJanela(db, "org-1")).resolves.toBe(false);

    const trilha = chamadas[0]?.join(" ") ?? "";
    expect(trilha).toContain("eq(organization_id=org-1)");
    expect(trilha).toContain("is(archived_at=null)");
  });

  it("WAHA não arquivado + Meta não arquivado => rejeitado sem fallback (org mista com Meta vivo)", async () => {
    const { db } = fakeDb([
      { data: [{ provider: "waha" }, { provider: "meta_cloud" }], error: null },
    ]);

    await expect(orgExigeTemplateForaDaJanela(db, "org-1")).resolves.toBe(true);
  });

  it("só Meta arquivado / nenhum canal elegível => fail-closed (exige)", async () => {
    const { db } = fakeDb([{ data: [], error: null }]);

    await expect(orgExigeTemplateForaDaJanela(db, "org-1")).resolves.toBe(true);
  });

  it("Meta não arquivado => continua exigindo", async () => {
    const { db } = fakeDb([{ data: [{ provider: "meta_cloud" }], error: null }]);

    await expect(orgExigeTemplateForaDaJanela(db, "org-1")).resolves.toBe(true);
  });

  it("erro de leitura => fail-closed (exige)", async () => {
    const { db } = fakeDb([
      { data: null, error: { code: "42501", message: "permission denied" } },
    ]);

    await expect(orgExigeTemplateForaDaJanela(db, "org-1")).resolves.toBe(true);
  });

  it("banco sem a migration 0106: repete sem o filtro e segue elegível", async () => {
    const { db, chamadas } = fakeDb([
      { data: null, error: { code: "42703", message: "column channel_sessions.archived_at does not exist" } },
      { data: [{ provider: "waha" }], error: null },
    ]);

    await expect(orgExigeTemplateForaDaJanela(db, "org-1")).resolves.toBe(false);
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]?.join(" ")).not.toContain("is(archived_at");
  });
});
