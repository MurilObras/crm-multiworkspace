/** Ensaio do Conversador. Não recebe CRM client/adapter: efeitos são só propostas. */
import type pg from "pg";
import { z } from "zod";
import {
  tool,
  type ToolSet,
  type LlmEdgeConfig,
  type RunModelCallDeps,
} from "../edge/llm/run-model-call";
import { loadConversationInstructions, runConversationModel } from "./conversation-model";
import {
  AGENT_TOOL_DEFS,
  buildOpeningMessage,
  TRANSPARENCIA_SYSTEM_BLOCK,
  CASES_SYSTEM_BLOCK,
  AGENDA_SYSTEM_BLOCK,
  DEFAULT_MAX_SENDS_PER_TURN,
} from "./inbound-turn";
import type { PublishedAgentConfig } from "./agent-config";
import { detectAmbiguousOptOut, detectHumanHandoffRequest } from "./human-handoff";
import { matchesHandoffKeyword } from "./agent-config";
import { matchSkills, renderMatchedSkillBodies } from "./skills";
import { searchKnowledge } from "./search-knowledge";
import { getToolByName } from "@/lib/mcp/tools";
import { BLOCKED_TOOL_IDS } from "../edge/crm/mcp-tools";
import {
  capacidadesEntreguesAoOperador,
  catalogoEntregueAoOperador,
} from "./entrega-de-capacidade";
import { renderApprovedMedia } from "@/lib/ai/agents/approved-media";
import { collectApprovedMediaUrls } from "./approved-media";
import { projetarContexto, projetarRetornoDeTool } from "./projecao";
import { BEFORE_SEND_GATES, type GateContext } from "../guardrails/before-send";
import { loadPromiseTable } from "../guardrails/promise/table";
import { loadDisclosureTemplate } from "../guardrails/disclosure/template";
import { PACING_DEFAULTS } from "../pacing/defaults";
import { SPINNING_DEFAULTS } from "../spinning/defaults";
import { sendInBubbles } from "./split-message";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import { guardCurrentInboundTools } from "./current-inbound-tools";
import { fusoDaOrganizacao } from "./fuso-da-org";
import { renderAgora } from "@/lib/tempo/agora";
import type { LeadContext } from "../edge/crm/get-lead-context";
import { fitLeadContextToBudget } from "../edge/crm/get-lead-context";

export interface TestConversationInput {
  organizationId: string;
  agent: PublishedAgentConfig;
  message: string;
  contact?: { name?: string; phone?: string };
  history?: Array<{ direction: "inbound" | "outbound"; body: string }>;
}

const CONTENT_GATES = new Set([
  "promise",
  "case_promise",
  "internal_vocabulary",
  "agenda_stall",
  "disclosure",
]);
export const TEST_LIMITATIONS = [
  {
    gate: "delivery",
    porque: "Envio, entrega, fila, ordem de chegada e limites do número exigem WhatsApp real.",
  },
  {
    gate: "contact",
    porque:
      "Cliente fictício: sem cadastro, memória individual, etapa real, opt-out ou base legal do contato.",
  },
  {
    gate: "actions",
    porque:
      "Ações e consultas do catálogo são simuladas; nenhum contato, negócio, chamado ou agenda é alterado.",
  },
  {
    gate: "audio",
    porque:
      "Catálogo aprovado é carregado; disparo obrigatório, etapa e deduplicação de áudio exigem uma conversa real.",
  },
  {
    gate: "routing",
    porque:
      "Ensaio do agente escolhido: não testa roteador, Operador, compactação, referências de skills nem classificadores auxiliares do worker.",
  },
  {
    gate: "transport_guards",
    porque:
      "Horários, pacing, spinning, janela de 24h e promessa semântica não são aprovados por este ensaio.",
  },
] as const;

export interface TestConversationResult {
  final_text: string;
  messages: string[];
  tool_calls: Array<{
    step: number;
    tool_name: string;
    args: unknown;
    result: unknown;
    started_at: string;
    ended_at: string;
  }>;
  status: "completed" | "aborted" | "handoff";
  tokens_in: number;
  tokens_out: number;
  cost_cents: number | null;
  latency_ms: number;
  runtime: "conversation_engine";
  limitations: ReadonlyArray<{ gate: string; porque: string }>;
  gates: Array<{ gate: string; pass: boolean; code?: string }>;
}

export async function testConversation(
  pool: pg.Pool,
  llm: LlmEdgeConfig,
  input: TestConversationInput,
  deps?: RunModelCallDeps,
): Promise<TestConversationResult> {
  const { organizationId: tenantId, agent } = input;
  const now = new Date();
  const history = [
    ...(input.history ?? []),
    { direction: "inbound" as const, body: input.message },
  ].slice(-agent.historyMessageWindow);
  const fuso = await fusoDaOrganizacao(pool, tenantId);
  const context: LeadContext = fitLeadContextToBudget(
    {
      lead_id: "",
      conversation_id: null,
      last_human_decision: null,
      contact: {
        name: input.contact?.name ?? null,
        phone: input.contact?.phone ?? null,
        email: null,
        tags: [],
        is_blocked: false,
      },
    },
    history.map((m, i) => ({
      ...m,
      type: "text",
      sent_at: new Date(now.getTime() - history.length + i),
      media_url: null,
      media_storage_path: null,
      media_mime: null,
      media_derived_text: null,
    })),
    agent.historyTokenWindow,
    fuso,
  );
  const messages: string[] = [];
  const trace: Array<{
    step: number;
    tool_name: string;
    args: unknown;
    result: unknown;
    started_at: string;
    ended_at: string;
  }> = [];
  const { playbook, skills, systemWithMemory } = await loadConversationInstructions(
    pool,
    tenantId,
    agent.systemPrompt,
  );
  const matching = matchSkills(skills, input.message);
  const delivered = capacidadesEntreguesAoOperador({
    operadorLigado: agent.operatorEnabled,
    ferramentasDoOperador: agent.operatorToolIds,
  });
  const catalogDelivered = catalogoEntregueAoOperador({
    operadorLigado: agent.operatorEnabled,
    ferramentasDoOperador: agent.operatorToolIds,
    ferramentasDoConversador: agent.toolIds,
  });
  const catalogIds = agent.toolIds.filter(
    (id) => !BLOCKED_TOOL_IDS.has(id) && !catalogDelivered.includes(id),
  );
  const audios = agent.approvedAudios ?? [];
  const mediaUrls = new Set(collectApprovedMediaUrls(playbook.prompt));
  const promise = await loadPromiseTable(pool, tenantId);
  const disclosure = await loadDisclosureTemplate(pool, tenantId);
  const caseOpened = false;
  const agendaCalled = false;
  const gateTrace: Array<{ gate: string; pass: boolean; code?: string }> = [];
  let sendCount = 0;
  let bodyRejected = false;
  const maxSends = z.coerce
    .number()
    .int()
    .positive()
    .catch(DEFAULT_MAX_SENDS_PER_TURN)
    .parse(process.env.MAX_SENDS_PER_TURN);
  const tools: ToolSet = {};
  const mountedCatalog: string[] = [];
  const simulated = (_name: string) => {
    // Sem fabricar disponibilidade, ids, saldo, horários ou sucesso real.
    return {
      ok: false,
      simulated: true,
      error: {
        code: "simulation_only",
        message:
          "Ação apenas registrada no ensaio; não foi executada. Não afirme sucesso nem invente resultados.",
      },
    };
  };
  const executeSend = async (raw: unknown) => {
    const parsed = AGENT_TOOL_DEFS.send_message.inputSchema.parse(raw);
    if (sendCount >= maxSends)
      return {
        ok: false,
        error: { code: "turn_send_limit", message: "Limite de mensagens deste turno atingido." },
      };
    const media = parsed.media;
    if (media) {
      const approved =
        media.type === "audio"
          ? audios.some((a) => a.id === media.audio_id && a.enabled && !('type' in a))
          : 'media_id' in media ? audios.some(a => a.id === media.media_id && a.enabled && 'type' in a && a.type === media.type) : mediaUrls.has(media.url);
      return {
        ok: false,
        simulated: true,
        error: {
          code: approved ? "media_simulation_only" : "media_not_approved",
          message: approved
            ? "Mídia aprovada; entrega e elegibilidade final não são simuladas. Não afirme que enviou."
            : "Mídia não aprovada para este agente.",
        },
      };
    }
    const gateContext: GateContext = {
      now,
      body: parsed.body,
      // O ensaio avalia só conteúdo e não possui canal. Se um gate passar a
      // depender do transporte, falhe explicitamente em vez de inventar um.
      get provider(): never {
        throw new Error("test_transport_unavailable");
      },
      optedOut: false,
      pacing: {
        knobs: PACING_DEFAULTS,
        state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
        crmDailyLimit: null,
      },
      spinning: { knobs: SPINNING_DEFAULTS, window: [] },
      promise: { table: promise?.table ?? null },
      semanticPromise: null,
      disclosure: {
        template: disclosure?.body ?? null,
        isFirstOutbound: !history.some((m) => m.direction === "outbound") && messages.length === 0,
        mode: process.env.DISCLOSURE_MODE === "veto" ? "veto" : "inject",
      },
      lgpd: null,
      casesEnabled: agent.casesEnabled,
      hasOpenCase: false,
      openedCaseThisTurn: caseOpened,
      humanPromiseExtraTargets: agent.handoffKeywords,
      internalVocabularyEnforced: true,
      agenda: {
        active: agent.toolIds.includes("crm_book_appointment"),
        toolCalledThisTurn: agendaCalled,
      },
    };
    // Usa os gates REAIS, somente onde há insumo. Os demais ficam explicitamente fora.
    for (const gate of BEFORE_SEND_GATES.filter((g) => CONTENT_GATES.has(g.name))) {
      const verdict = gate.evaluate(gateContext);
      gateTrace.push({
        gate: gate.name,
        pass: verdict.pass,
        ...(!verdict.pass ? { code: verdict.code } : {}),
      });
      if (!verdict.pass)
        return { ok: false, error: { code: verdict.code, message: verdict.reason } };
      if (verdict.amendBody) gateContext.body = verdict.amendBody;
    }
    const outcome = await sendInBubbles(gateContext.body, {
      enabled: agent.splitMessages,
      maxChars: agent.splitMaxChars,
      maxBubbles: maxSends - sendCount,
      sleep: async () => {},
      jitter: () => 0,
      send: async (body) => {
        if (!body.trim() || !sendMessageSchema.shape.body.safeParse(body).success) {
          bodyRejected = true;
          return { kind: "failed" };
        }
        messages.push(body);
        sendCount++;
        return { kind: "sent" };
      },
    });
    if (outcome.kind === "failed")
      return {
        ok: false,
        error: {
          code: "invalid_message_body",
          message:
            "A bolha excede o tamanho permitido pelo CRM ou está vazia. Reescreva sem cortar informação.",
        },
      };
    return { ok: true, simulated: true, status: "preview_only" };
  };
  const add = (
    name: string,
    description: string,
    inputSchema: z.ZodType,
    execute: (args: unknown) => Promise<unknown>,
  ) => {
    tools[name] = tool({
      description,
      inputSchema,
      execute: async (args) => {
        const started = new Date().toISOString();
        const result = await execute(args);
        trace.push({
          step: trace.length + 1,
          tool_name: name,
          args,
          result,
          started_at: started,
          ended_at: new Date().toISOString(),
        });
        return result;
      },
    });
  };
  for (const [name, def] of Object.entries(AGENT_TOOL_DEFS)) {
    if (delivered.includes(name)) continue;
    if (name === "send_template") continue;
    if (["open_human_case", "provide_case_update"].includes(name) && !agent.casesEnabled) continue;
    if (name === "read_skill_reference") continue; // Referências dependem de Storage; limite declarado abaixo.
    if (name === "request_human_handoff" && !agent.handoffToolEnabled) continue;
    if (name === "schedule_followup") continue; // Worker só oferece com janela de instalação configurada.
    if (name === "search_knowledge" && !agent.knowledgeSourceIds.length && !agent.activeKbVersionId)
      continue;
    add(name, def.description, def.inputSchema, async (args) => {
      if (name === "send_message") return executeSend(args);
      if (name === "get_lead_context")
        return { ok: true, context: mountedCatalog.length ? context : projetarContexto(context) };
      if (name === "search_knowledge") {
        const { query } = AGENT_TOOL_DEFS.search_knowledge.inputSchema.parse(args);
        const result = await searchKnowledge(pool, {
          organizationId: tenantId,
          knowledgeSourceIds: agent.knowledgeSourceIds,
          kbVersionId: agent.activeKbVersionId,
          query,
          topK: agent.ragTopK,
          threshold: agent.ragSimilarityThreshold,
          agentId: agent.agentId,
        });
        if (result.ok)
          for (const hit of result.results)
            for (const url of collectApprovedMediaUrls(hit.content)) mediaUrls.add(url);
        return mountedCatalog.length ? result : projetarRetornoDeTool(result);
      }
      return simulated(name);
    });
  }
  for (const id of catalogIds) {
    const def = getToolByName(id);
    if (def && !(id in tools)) {
      mountedCatalog.push(id);
      add(id, def.description, z.object(def.inputSchema), async () => simulated(id));
    }
  }
  const system = [
    systemWithMemory,
    TRANSPARENCIA_SYSTEM_BLOCK,
    renderApprovedMedia(audios),
    agent.casesEnabled ? CASES_SYSTEM_BLOCK : "",
    agent.toolIds.includes("crm_book_appointment") ? AGENDA_SYSTEM_BLOCK : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const opening = [
    buildOpeningMessage(null, null, context, "", mountedCatalog.length === 0, delivered),
    renderAgora(now, fuso),
    renderMatchedSkillBodies(matching.matched),
    agent.splitMessages
      ? "Responda em mensagens curtas e naturais, uma ideia por mensagem — como uma pessoa digitando no WhatsApp. Prefira várias mensagens curtas a um texto único e longo."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (
    detectHumanHandoffRequest(input.message) ||
    matchesHandoffKeyword(input.message, agent.handoffKeywords) ||
    detectAmbiguousOptOut(input.message)
  ) {
    return {
      final_text: "",
      messages,
      tool_calls: trace,
      status: "handoff",
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
      latency_ms: 0,
      runtime: "conversation_engine",
      limitations: TEST_LIMITATIONS,
      gates: gateTrace,
    };
  }
  // O SDK pode chamar tools em paralelo. Preserve a fila local usada no worker
  // para não intercalar bolhas nem ultrapassar o limite físico do turno.
  const execution = guardCurrentInboundTools(tools, async () => {});
  let call;
  try {
    call = await runConversationModel(
      pool,
      llm,
      {
        tenantId,
        agentId: agent.agentId,
        // O inventário estático do repositório reconhece este literal com aspas simples.
        // prettier-ignore
        purpose: 'agent_test',
        system,
        messages: [{ role: "user", content: opening }],
        tools: execution.tools,
        maxSteps: agent.maxSteps,
        model: agent.model,
        llmOverride: { provider: agent.provider, credentialId: agent.credentialId },
      },
      deps,
    );
  } finally {
    await execution.drain();
  }
  // Igual ao worker: texto fora de send_message NÃO vira resposta ao cliente.
  return {
    final_text: messages.join("\n\n"),
    messages,
    tool_calls: trace,
    status: messages.length && !bodyRejected ? "completed" : "aborted",
    tokens_in: call.usage.inputTokens,
    tokens_out: call.usage.outputTokens,
    cost_cents: call.costCents,
    latency_ms: call.latencyMs,
    runtime: "conversation_engine",
    limitations: TEST_LIMITATIONS,
    gates: gateTrace,
  };
}
