/** Ensaio do Conversador. Não recebe CRM client/adapter: efeitos são só propostas. */
import type pg from "pg";
import { z } from "zod";
import {
  tool,
  runModelCall,
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
import { collectApprovedMediaUrls, containsMediaLink } from "./approved-media";
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
import { mediaKind } from "@/lib/ai/agents/approved-media";
import {
  authorizeMediaIntent,
  MEDIA_INTENT_INSTRUCTION,
  NO_MEDIA_INTENT,
  parseMediaIntent,
} from "./media-intent";
import { audioIntentMessage } from "./audio-rule";
import { explicitMediaPreference, withTurnMediaPreference } from "./media-preference";
import { durableMediaPreference } from "./media-preference-scope";
import type { MediaDiagnostic, MediaSimulation } from "@/lib/ai/agents/media-simulation";
import { renderMediaDecisionInstruction } from "@/lib/ai/agents/media-simulation";
import { resolveExplicitMediaReference } from './media-reference';
import { coherentMediaContext } from './media-response-context';

export interface TestConversationInput {
  organizationId: string;
  agent: PublishedAgentConfig;
  message: string;
  contact?: { name?: string; phone?: string };
  history?: Array<{ direction: "inbound" | "outbound"; body: string }>;
  mediaContext?: MediaSimulation;
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
      "A decisão e a elegibilidade são simuladas com o catálogo aprovado e o cenário fictício. Não confirmam entrega nem o estado de um contato real.",
  },
  {
    gate: "routing",
    porque:
      "Ensaio do agente escolhido: inclui o classificador de mídia, mas não testa roteador, Operador, compactação ou referências de skills.",
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
  media_decision?: MediaDiagnostic;
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
  const catalog = agent.approvedAudios ?? [];
  let intent = { ...NO_MEDIA_INTENT };
  let classificationReason: string | undefined;
  let classifierCost: number | null = 0;
  let classifierTokensIn = 0,
    classifierTokensOut = 0,
    classifierLatency = 0;
  const handoff =
    detectHumanHandoffRequest(input.message) ||
    matchesHandoffKeyword(input.message, agent.handoffKeywords) ||
    detectAmbiguousOptOut(input.message);
  const reference = !handoff ? resolveExplicitMediaReference(input.message, catalog) : null;
  if (reference) {
    intent = reference.intent;
    classificationReason = reference.reason;
  } else if (catalog.some((m) => m.enabled) && !handoff) {
    try {
      const decision = await runModelCall(
        pool,
        llm,
        {
          tenantId,
          agentId: agent.agentId,
          purpose: "agent_test",
          model: agent.model,
          llmOverride: { provider: agent.provider, credentialId: agent.credentialId },
          system: MEDIA_INTENT_INSTRUCTION,
          messages: [
            {
              role: "user",
              content: audioIntentMessage(
                input.message,
                catalog.filter((m) => m.enabled),
                [...(input.mediaContext?.delivered_ids ?? [])].reverse(),
                !input.history?.some((m) => m.direction === "outbound"),
              ),
            },
          ],
        },
        deps,
      );
      intent = parseMediaIntent(
        decision.result.text,
        catalog,
        input.message,
        (reason) => {
          classificationReason = reason;
        },
        agent.mediaReplayPolicy ?? "explicit_media_request",
      );
      classifierCost = decision.costCents;
      classifierTokensIn = decision.usage.inputTokens;
      classifierTokensOut = decision.usage.outputTokens;
      classifierLatency = decision.latencyMs;
    } catch {
      classificationReason = "classifier_unavailable";
      classifierCost = null;
      /* Sem classificação confiável: só texto, sem inventar envio. */
    }
  }
  const chosen = catalog.find((m) => m.id === intent.audio_id);
  const scenario = input.mediaContext;
  let durableText = scenario?.scenario === "text_preference";
  if (chosen)
    for (const message of [
      ...(input.history ?? []),
      { direction: "inbound", body: input.message },
    ]) {
      if (message.direction !== "inbound") continue;
      const pref = durableMediaPreference(message.body, (clause) =>
        explicitMediaPreference(clause, mediaKind(chosen)),
      );
      if (pref) durableText = pref === "text";
    }
  const usedIds = new Set(scenario?.delivered_ids ?? []);
  if (scenario?.scenario === "delivered" && chosen) usedIds.add(chosen.id);
  const eligibility = chosen
    ? authorizeMediaIntent({
        item: chosen,
        intent,
        policy: agent.mediaReplayPolicy ?? "explicit_media_request",
        legacyRequest: explicitMediaPreference(input.message, mediaKind(chosen)) === "audio",
        allowsFormat:
          explicitMediaPreference(input.message, mediaKind(chosen)) !== "text" &&
          (withTurnMediaPreference(!durableText, input.message, mediaKind(chosen)) ||
            intent.format === mediaKind(chosen) ||
            intent.intent === "repeat"),
        inbound: "simulation-current-request",
        used: [
          ...catalog
            .filter((m) => usedIds.has(m.id))
            .map((m) => ({ id: m.id, fingerprint: m.content_sha256, confirmed: true })),
          ...(scenario?.delivered_fingerprints ?? []).map((fingerprint) => ({
            id: "simulation-fingerprint",
            fingerprint,
            confirmed: true,
          })),
        ],
      })
    : {
        allowed: false,
        reason: intent.text_only
          ? "text_preference"
          : (classificationReason ?? "no_matching_media"),
      };
  if (
    chosen?.stage_ids.length &&
    (!scenario?.stage_id || !chosen.stage_ids.includes(scenario.stage_id))
  ) {
    eligibility.allowed = false;
    eligibility.reason = "stage_not_permitted";
  }
  if (
    chosen?.trigger_type === "first_contact" &&
    input.history?.some((m) => m.direction === "outbound") &&
    intent.intent !== "repeat"
  ) {
    eligibility.allowed = false;
    eligibility.reason = "first_contact_only";
  }
  const audios = chosen && eligibility.allowed ? [chosen] : [];
  const mediaDiagnostic: MediaDiagnostic = {
    intent: intent.intent,
    format: intent.format,
    media_id: chosen?.id ?? null,
    title: chosen?.title ?? null,
    authorized: eligibility.allowed,
    reason: handoff ? "human_handoff" : eligibility.reason,
    transport: "not_attempted",
    fingerprint: chosen?.content_sha256 ?? null,
  };
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
  if (chosen?.required && maxSends < 2) {
    eligibility.allowed = false;
    eligibility.reason = "turn_send_limit";
    mediaDiagnostic.authorized = false;
    mediaDiagnostic.reason = "turn_send_limit";
  }
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
    if (sendCount >= maxSends - (chosen?.required && eligibility.allowed && !parsed.media ? 1 : 0))
      return {
        ok: false,
        error: { code: "turn_send_limit", message: "Limite de mensagens deste turno atingido." },
      };
    const media = parsed.media;
    if (
      !media &&
      (agent.managedMediaConfigured ||
        catalog.length ||
        agent.mediaReplayPolicy === "explicit_repeat") &&
      containsMediaLink(parsed.body)
    )
      return {
        ok: false,
        simulated: true,
        error: {
          code: "media_url_fallback_forbidden",
          message:
            "Não use link como alternativa à mídia gerenciada. Responda por texto sem contornar o veto.",
        },
      };
    if (!media && mediaDiagnostic.transport === "planned")
      return {
        ok: false,
        simulated: true,
        error: {
          code: "media_response_completed",
          message:
            "A resposta com mídia já está planejada. Encerre sem explicação repetida ou promessa de entrega.",
        },
      };
    if (media) {
      if (chosen?.required)
        return {
          ok: false,
          simulated: true,
          error: {
            code: "audio_managed_by_rule",
            message:
              "O CRM cuida do planejamento da mídia obrigatória após o contexto. Não a envie por conta própria.",
          },
        };
      const approved =
        media.type === "audio"
          ? audios.some((a) => a.id === media.audio_id && a.enabled && !("type" in a))
          : "media_id" in media
            ? audios.some(
                (a) => a.id === media.media_id && a.enabled && "type" in a && a.type === media.type,
              )
            : mediaUrls.has(media.url);
      if (
        !approved ||
        mediaDiagnostic.transport === "planned" ||
        !audios.length ||
        "url" in media ||
        !messages.length
      )
        return {
          ok: false,
          simulated: true,
          error: {
            code: "media_not_authorized",
            message: "Mídia indisponível nesta resposta. Não afirme envio nem contorne por URL.",
          },
        };
      mediaDiagnostic.transport = "planned";
      sendCount++;
      return {
        ok: true,
        simulated: true,
        status: "planned",
        delivered: false,
        message:
          "Mídia planejada no ensaio, sem transporte real. Não acrescente fallback nem afirme entrega.",
      };
    }
    if (chosen && eligibility.allowed) {
      const context = coherentMediaContext(parsed.body, mediaKind(chosen));
      parsed.body = context.body;
      if (context.amended) gateTrace.push({ gate: 'media_context', pass: true, code: 'media_context_reconciled' });
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
    chosen?.required && eligibility.allowed
      ? `Mídia obrigatória correspondente será somente PLANEJADA após a resposta: ${JSON.stringify({ id: chosen.id, title: chosen.title })}. Responda com contexto breve, sem anunciar envio, repetir a explicação ou oferecer URL alternativa.`
      : "",
    agent.managedMediaConfigured || catalog.length || agent.mediaReplayPolicy === "explicit_repeat"
      ? renderMediaDecisionInstruction(mediaDiagnostic)
      : "",
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
      media_decision: mediaDiagnostic,
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
  if (chosen?.required && eligibility.allowed && !messages.length && !bodyRejected && maxSends >= 2)
    await executeSend({ body: chosen.title });
  if (
    chosen?.required &&
    eligibility.allowed &&
    mediaDiagnostic.transport !== "planned" &&
    !bodyRejected &&
    messages.length &&
    sendCount < maxSends
  ) {
    mediaDiagnostic.transport = "planned";
    trace.push({
      step: trace.length + 1,
      tool_name: "media_plan",
      args: { media_id: chosen.id },
      result: {
        ok: true,
        simulated: true,
        status: "planned",
        delivered: false,
        media_decision: mediaDiagnostic,
      },
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });
  }
  trace.push({
    step: trace.length + 1,
    tool_name: "media_decision",
    args: {},
    result: mediaDiagnostic,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  });
  // Igual ao worker: texto fora de send_message NÃO vira resposta ao cliente.
  return {
    final_text: messages.join("\n\n"),
    messages,
    tool_calls: trace,
    status: messages.length && !bodyRejected ? "completed" : "aborted",
    tokens_in: call.usage.inputTokens + classifierTokensIn,
    tokens_out: call.usage.outputTokens + classifierTokensOut,
    cost_cents:
      call.costCents == null || classifierCost == null ? null : call.costCents + classifierCost,
    latency_ms: call.latencyMs + classifierLatency,
    runtime: "conversation_engine",
    limitations: TEST_LIMITATIONS,
    gates: gateTrace,
    media_decision: mediaDiagnostic,
  };
}
