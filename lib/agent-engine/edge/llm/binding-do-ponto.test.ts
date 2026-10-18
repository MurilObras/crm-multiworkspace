import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { decidirParaOSeam } from "./binding-do-ponto";

describe("modelo do ensaio acompanha o atendimento", () => {
  it('flush usa a escolha de compaction do painel', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await decidirParaOSeam({ query } as never, { organizationId: 'org-A', purpose: 'flush',
      modeloDoCallSite: undefined, overrideDoAgente: null,
      padraoDaOrganizacao: { provider: 'anthropic', defaultModel: 'padrão' } });
    expect(query).toHaveBeenCalledWith(expect.any(String), ['org-A', 'compaction']);
  });
  it.each([true, false])("mesma decisão com binding configurado=%s", async (configured) => {
    const query = vi.fn(async () => ({
      rows: configured
        ? [
            {
              purpose: "agent_turn",
              provider: "openai",
              credential_id: "cred-binding",
              model_id: "modelo-binding",
              base_url: null,
              is_enabled: true,
            },
          ]
        : [],
    }));
    const db = { query } as unknown as pg.Pool;
    const base = {
      organizationId: "org-A",
      modeloDoCallSite: "modelo-publicado",
      overrideDoAgente: {
        provider: "openai",
        credentialId: "cred-publicada",
        model: "modelo-publicado",
      },
      padraoDaOrganizacao: { provider: "anthropic", defaultModel: "modelo-default" },
    };
    const live = await decidirParaOSeam(db, { ...base, purpose: "agent_turn" });
    const preview = await decidirParaOSeam(db, { ...base, purpose: "agent_test" });
    expect(preview).toEqual(live);
    expect(query.mock.calls).toHaveLength(2);
    // O binding tem de vir da mesma org/ponto, sem configuração paralela do teste.
    expect((query.mock.calls as unknown[][])[1]?.[1]).toEqual(["org-A", "agent_turn"]);
  });
});
