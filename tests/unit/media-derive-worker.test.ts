import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadMock = vi.fn();
const updateEqMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg",
  media_derived_status: null as string | null,
};

/**
 * O dublê PRECISA saber em que tabela está.
 *
 * A versão anterior devolvia `messageRow` para qualquer `from(...)` e encadeava
 * exatamente dois `.eq`. Isso a tornava frágil nos dois eixos: o worker passou a
 * consultar `ai_purpose_bindings` (com três filtros) e o stub quebrava no
 * terceiro `.eq` — falha que aparece como "status error" e aponta para o lugar
 * errado. O Proxy devolve o chain para qualquer filtro, e a linha vem por
 * tabela: mensagem para `messages`, NENHUM binding para `ai_purpose_bindings`
 * (o caso "ninguém configurou nada", que é o comportamento anterior que estes
 * casos existem para preservar).
 */
const bindingDeVisao: { provider: string; model_id: string; credential_id: string | null } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha = tabela === "ai_purpose_bindings" ? bindingDeVisao : messageRow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: linha ? [linha] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) =>
          prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain,
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "transcrição do áudio real"),
}));

// resolveOrgLlmConfig e generateText mockados: o worker precisa de credencial p/
// montar as deps, mas o teste não exercita rede.
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  })),
}));

import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText } from "@/lib/messaging/media/derive";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("deriveMessageMedia", () => {
  beforeEach(() => {
    downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    updateEqMock.mockReset();
    vi.mocked(resolveOrgLlmConfig).mockClear();
    messageRow.media_derived_status = null;
    messageRow.type = "audio";
    vi.mocked(deriveMediaText).mockReset().mockResolvedValue("transcrição do áudio real");
  });

  it("baixa a mídia, deriva e grava ready", async () => {
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "transcrição do áudio real", media_derived_status: "ready" }),
    );
  });
  it('download travado termina com erro e marca failed na última tentativa', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    downloadMock.mockImplementation((_path, _options, parameters) => new Promise((_resolve, reject) => {
      parameters.signal.addEventListener('abort', () => reject(parameters.signal.reason), { once: true });
    }));
    try {
      const pending = deriveMessageMedia(eventRow(4));
      await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(60_000);
      controller.abort(new DOMException('Download timed out', 'TimeoutError'));
      expect((await pending).status).toBe('error');
      expect(deriveMediaText).not.toHaveBeenCalled();
      expect(updateEqMock).toHaveBeenCalledWith(expect.objectContaining({ media_derived_status: 'failed' }));
    } finally { timeout.mockRestore(); }
  });

  it("pula se já derivado (idempotência)", async () => {
    messageRow.media_derived_status = "ready";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(deriveMediaText).not.toHaveBeenCalled();
  });

  it("tipo sem derivado (sticker) → skipped sem baixar", async () => {
    messageRow.type = "sticker";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("erro na derivação marca failed no último attempt", async () => {
    vi.mocked(deriveMediaText).mockRejectedValue(new Error("transcription_503"));
    const r = await deriveMessageMedia(eventRow(4));
    expect(r.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
  });
});

// Regressões do incidente: a chave do chat podia impedir a própria transcrição.
describe("credenciais por capacidade e resultado honesto", () => {
  it("áudio resolve somente OpenAI; não consulta o padrão de chat", async () => {
    messageRow.type = "audio"; messageRow.media_derived_status = null;
    vi.mocked(resolveOrgLlmConfig).mockClear();
    vi.mocked(deriveMediaText).mockResolvedValue("conteúdo transcrito");
    expect((await deriveMessageMedia(eventRow())).status).toBe("ok");
    expect(resolveOrgLlmConfig).toHaveBeenCalledTimes(1);
    expect(resolveOrgLlmConfig).toHaveBeenCalledWith(expect.anything(),expect.anything(),"org1",{provider:"openai"});
  });
  it("PDF não precisa de chave de chat ou transcrição", async () => {
    messageRow.type = "document"; messageRow.media_derived_status = null; messageRow.media_mime = "application/pdf";
    vi.mocked(resolveOrgLlmConfig).mockClear();
    vi.mocked(deriveMediaText).mockResolvedValue("texto extraído do PDF");
    expect((await deriveMessageMedia(eventRow())).status).toBe("ok");
    expect(resolveOrgLlmConfig).not.toHaveBeenCalled();
  });
  it.each(["", "   ", "[o cliente enviou uma mídia que não consegui interpretar]"])("não grava ready para conteúdo indisponível: %s", async (text) => {
    messageRow.type = "audio"; messageRow.media_derived_status = null;
    updateEqMock.mockClear(); vi.mocked(deriveMediaText).mockResolvedValue(text);
    expect((await deriveMessageMedia(eventRow())).status).toBe("error");
    expect(updateEqMock).not.toHaveBeenCalledWith(expect.objectContaining({media_derived_status:"ready"}));
  });
});

it("documento sem extrator não baixa repetidamente nem chama IA",async()=>{
 messageRow.type="document";messageRow.media_mime="application/vnd.ms-excel";messageRow.media_derived_status=null;
 downloadMock.mockClear();vi.mocked(resolveOrgLlmConfig).mockClear();
 expect((await deriveMessageMedia(eventRow())).status).toBe("skipped");expect(downloadMock).not.toHaveBeenCalled();expect(resolveOrgLlmConfig).not.toHaveBeenCalled();
});
