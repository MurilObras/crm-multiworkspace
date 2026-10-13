import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testConversation } from "./test-conversation";
import { loadConversationInstructions, runConversationModel } from "./conversation-model";
import { searchKnowledge } from "./search-knowledge";
import { getToolByName } from "@/lib/mcp/tools";
import type { PublishedAgentConfig } from "./agent-config";
import { testRunSchema } from "@/lib/ai/agents/validation";

vi.mock("./conversation-model", () => ({
  loadConversationInstructions: vi.fn(),
  runConversationModel: vi.fn(),
}));
vi.mock("./search-knowledge", () => ({ searchKnowledge: vi.fn() }));
vi.mock("../guardrails/promise/table", () => ({ loadPromiseTable: vi.fn(async () => null) }));
vi.mock("../guardrails/disclosure/template", () => ({
  loadDisclosureTemplate: vi.fn(async () => null),
}));
vi.mock("./fuso-da-org", () => ({ fusoDaOrganizacao: vi.fn(async () => "America/Sao_Paulo") }));
vi.mock("@/lib/mcp/tools", () => ({ getToolByName: vi.fn() }));

const config = {
  agentId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  agentName: "Paulo",
  multimodalInput: false,
  operatorModel: null,
  pipelineIds: [],
  janelaDeAtendimento: null,
  versionCreatedBy: null,
  agentCreatedBy: null,
  systemPrompt: "Paulo",
  provider: "openai",
  model: "modelo-do-agente",
  credentialId: "credencial",
  maxSteps: 9,
  historyMessageWindow: 40,
  historyTokenWindow: 10000,
  splitMessages: true,
  splitMaxChars: 80,
  handoffToolEnabled: true,
  handoffKeywords: [],
  knowledgeSourceIds: ["fonte-autorizada"],
  activeKbVersionId: null,
  toolIds: ["crm_move_lead_stage", "crm_send_whatsapp_message"],
  operatorEnabled: false,
  operatorToolIds: [],
  casesEnabled: false,
  ragTopK: 4,
  ragSimilarityThreshold: 0.42,
  approvedAudios: [],
} as PublishedAgentConfig;
const pool = {} as never;
const options = { toolCallId: "test", messages: [], context: undefined };
afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAX_SENDS_PER_TURN", "3");
  vi.mocked(loadConversationInstructions).mockResolvedValue({
    playbook: { prompt: "plataforma + Paulo", versionIds: {} },
    systemWithMemory: "plataforma + Paulo + memória do workspace",
    skills: [
      {
        name: "objeções",
        versionId: "skill-v1",
        description: "Objeções de compra",
        manifest: [],
        body: "Investigue o motivo do preço.",
        matcher: { any_keywords: ["caro"] },
      },
    ],
  });
});

describe("ensaio do Conversador sem efeitos reais", () => {
  it("tools paralelas conservam grupos de bolhas e o limite físico do turno", async () => {
    vi.mocked(runConversationModel).mockImplementation(async (_db, _cfg, input) => {
      const send = (body: string) => input.tools!.send_message!.execute!({ body }, options);
      const outcomes = await Promise.all([
        send("Primeira mensagem. Segunda mensagem."),
        send("Terceira mensagem. Quarta mensagem."),
        send("Quinta mensagem."),
      ]);
      expect(outcomes[2]).toMatchObject({ ok: false, error: { code: "turn_send_limit" } });
      return { usage: { inputTokens: 1, outputTokens: 1 }, costCents: 0, latencyMs: 1 } as never;
    });
    const result = await testConversation(
      pool,
      {},
      {
        organizationId: "org",
        agent: { ...config, splitMaxChars: 22 },
        message: "Me explica",
      },
    );
    expect(result.messages).toEqual([
      "Primeira mensagem.",
      "Segunda mensagem.",
      "Terceira mensagem. Quarta mensagem.",
    ]);
  });

  it("não aprova bolha atômica maior que o contrato real de envio", async () => {
    vi.mocked(runConversationModel).mockImplementation(async (_db, _cfg, input) => {
      const outcome = await input.tools!.send_message!.execute!(
        { body: "a".repeat(4097) },
        options,
      );
      expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_message_body" } });
      return { usage: { inputTokens: 1, outputTokens: 1 }, costCents: 0, latencyMs: 1 } as never;
    });
    const result = await testConversation(
      pool,
      {},
      { organizationId: "org", agent: config, message: "Oi" },
    );
    expect(result.status).toBe("aborted");
    expect(result.messages).toEqual([]);
  });

  it("histórico aceita a mensagem máxima válida do CRM, sem travar a próxima rodada", () => {
    expect(
      testRunSchema.safeParse({
        sample_message: "Continue",
        sample_history: [{ direction: "outbound", body: "a".repeat(4096) }],
      }).success,
    ).toBe(true);
    expect(
      testRunSchema.safeParse({
        sample_message: "Continue",
        sample_history: [{ direction: "outbound", body: "a".repeat(4097) }],
      }).success,
    ).toBe(false);
  });
  it("usa contexto, skill, modelo/credencial e envia só pelas tools; texto solto é descartado", async () => {
    vi.mocked(runConversationModel).mockImplementation(async (_db, _cfg, input) => {
      expect(input.system).toContain("memória do workspace");
      expect(JSON.stringify(input.messages)).toContain("Investigue o motivo do preço.");
      expect(JSON.stringify(input.messages)).toContain("já expliquei");
      expect(input.model).toBe(config.model);
      expect(input.maxSteps).toBe(9);
      expect(input.llmOverride).toEqual({ provider: "openai", credentialId: "credencial" });
      expect(input.tools).not.toHaveProperty("crm_send_whatsapp_message");
      await input.tools!.send_message!.execute!(
        { body: "Que parte do valor te preocupa?" },
        options,
      );
      return {
        result: { text: "TEXTO QUE NÃO PODE VIRAR ENVIO" },
        usage: { inputTokens: 100, outputTokens: 20 },
        costCents: 1,
        latencyMs: 5,
      } as never;
    });
    const result = await testConversation(
      pool,
      {},
      {
        organizationId: "org",
        agent: config,
        message: "Achei caro",
        history: [{ direction: "outbound", body: "já expliquei" }],
      },
    );
    expect(result.messages).toEqual(["Que parte do valor te preocupa?"]);
    expect(result.final_text).not.toContain("TEXTO QUE");
    expect(result.tool_calls[0]?.tool_name).toBe("send_message");
    expect(result.gates.some((g) => g.gate === "internal_vocabulary" && g.pass)).toBe(true);
    expect(result.gates.map((g) => g.gate)).toEqual([
      "promise", "case_promise", "internal_vocabulary", "agenda_stall", "disclosure",
    ]);
  });

  it("consulta conhecimento só nas fontes do agente e não chama handlers MCP", async () => {
    const handler = vi.fn();
    vi.mocked(getToolByName).mockReturnValue({
      name: "crm_move_lead_stage",
      description: "mover",
      inputSchema: {},
      handler,
    } as never);
    vi.mocked(searchKnowledge).mockResolvedValue({ ok: true, results: [] });
    vi.mocked(runConversationModel).mockImplementation(async (_db, _cfg, input) => {
      await input.tools!.search_knowledge!.execute!({ query: "preço" }, options);
      const proposed = await input.tools!.crm_move_lead_stage!.execute!({}, options);
      expect(proposed).toMatchObject({ simulated: true });
      return {
        result: { text: "não enviado" },
        usage: { inputTokens: 1, outputTokens: 1 },
        costCents: 0,
        latencyMs: 1,
      } as never;
    });
    const result = await testConversation(
      pool,
      {},
      { organizationId: "org-A", agent: config, message: "qual preço?" },
    );
    expect(searchKnowledge).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        organizationId: "org-A",
        knowledgeSourceIds: ["fonte-autorizada"],
        topK: 4,
        threshold: 0.42,
      }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe("aborted");
    expect(result.messages).toEqual([]);
  });

  it("devolve veto real ao modelo e mostra só a reescrita aprovada", async () => {
    vi.mocked(runConversationModel).mockImplementation(async (_db, _cfg, input) => {
      const veto = await input.tools!.send_message!.execute!(
        { body: "Vou chamar crm_move_lead_stage agora." },
        options,
      );
      expect(veto).toMatchObject({ ok: false, error: { code: "internal_vocabulary_leak" } });
      await input.tools!.send_message!.execute!(
        { body: "Vamos seguir com a opção que você escolheu." },
        options,
      );
      return {
        result: { text: "" },
        usage: { inputTokens: 1, outputTokens: 1 },
        costCents: 0,
        latencyMs: 1,
      } as never;
    });
    const result = await testConversation(
      pool,
      {},
      { organizationId: "org", agent: config, message: "vamos seguir" },
    );
    expect(result.messages).toEqual(["Vamos seguir com a opção que você escolheu."]);
    expect(result.gates.some((g) => !g.pass)).toBe(true);
  });

  it("pedido de humano interrompe antes do modelo, sem encaminhar contato real", async () => {
    const result = await testConversation(
      pool,
      {},
      { organizationId: "org", agent: config, message: "quero falar com um humano" },
    );
    expect(result.status).toBe("handoff");
    expect(runConversationModel).not.toHaveBeenCalled();
  });
});
