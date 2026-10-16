/**
 * POST /api/v1/ai/agents/:id/versions/:vid/test (admin)
 *
 * Spec 10 §4.4. Cria ai_agent_runs com is_dry_run=true e executa o runtime
 * do Conversador via `callInternalRuntime` → `testConversation`. Efeitos são simulados.
 *
 * INTERNAL_AGENT_RUN_STUB=true troca a execução por um trace fabricado —
 * serve para exercitar o render da UI sem gastar token, e NÃO é o default:
 * numa instalação nova, "Testar agente" tem que testar o agente.
 *
 * Crítico: dry_run=true → bypass do partial unique
 *   ai_agent_runs_one_running_per_conv (que filtra is_dry_run=false), por
 *   isso múltiplos tests simultâneos pra mesma conversation não conflitam.
 *
 * Sample contact é apenas pra contexto do prompt — nunca toca contacts/conversations
 * tables, nunca chama WAHA, nunca cria messages.outbound.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { testRunSchema } from "@/lib/ai/agents/validation";
import { avaliarRespostaDeTeste } from "@/lib/ai/agents/avaliar-resposta-de-teste";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string; vid: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id, vid } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(vid)) {
    return fail("invalid_request", "ids inválidos.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = testRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const { data: version } = await admin
    .from("ai_agent_versions")
    .select(
      "id, agent_id, organization_id, system_prompt, provider, model, channel_session_id, max_steps, token_budget, cost_budget_cents, tool_ids",
    )
    .eq("id", vid)
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", id)
    .maybeSingle();

  if (!version) return fail("not_found", "Version não encontrada.", 404, { requestId });

  const startedAt = new Date();

  const { data: runRow, error: runErr } = await admin
    .from("ai_agent_runs")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: id,
      agent_version_id: vid,
      conversation_id: null,
      contact_id: null,
      channel_session_id: version.channel_session_id,
      inbound_message_id: null,
      outbound_message_id: null,
      status: "running",
      is_dry_run: true,
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return fail("internal_error", "Erro ao iniciar test run.", 500, { requestId });
  }

  let resultPayload: Record<string, unknown>;

  try {
    if (env.INTERNAL_AGENT_RUN_STUB) {
      resultPayload = await runStubbedTest({
        runId: runRow.id,
        orgId: activeOrg.orgId,
        versionId: vid,
        sampleMessage: parsed.data.sample_message,
        sampleContact: parsed.data.sample_contact,
        version,
        startedAt,
      });
    } else {
      // Runtime real (S-13.08). Falha aqui é o caso comum de instalação nova —
      // credencial de IA ausente. Um 500 cru mandaria a pessoa pro log do
      // servidor; devolvemos o porquê legível na própria tela.
      resultPayload = await callInternalRuntime({
        runId: runRow.id,
        agentId: id,
        history: parsed.data.sample_history,
        orgId: activeOrg.orgId,
        versionId: vid,
        sampleMessage: parsed.data.sample_message,
        sampleContact: parsed.data.sample_contact,
      });
    }
  } catch (err) {
    const persistFailed = err instanceof Error && err.message === "test_run_persist_failed";
    const errorCode = persistFailed
      ? "agent_test_result_persist_failed"
      : "agent_test_execution_failed";
    const errorMessage = persistFailed
      ? "O agente executou, mas não foi possível salvar o resultado. Confira a atualização do banco da instalação."
      : "Não consegui executar o agente. Confira as credenciais de IA e a conexão com o banco da instalação.";
    logger.warn("agent_test_failed", {
      requestId,
      runId: runRow.id,
      organizationId: activeOrg.orgId,
      code: errorCode,
    });
    // O banco pode ser a causa da falha. Tentar encerrar o registro não pode
    // substituir a resposta amigável por outra exceção, nem expor o provider.
    try {
      const { error } = await admin
        .from("ai_agent_runs")
        .update({
          status: "failed",
          error_code: errorCode,
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runRow.id)
        .eq("organization_id", activeOrg.orgId);
      if (error) logger.warn("agent_test_failed_run_persist", { requestId, runId: runRow.id });
    } catch {
      logger.warn("agent_test_failed_run_persist", { requestId, runId: runRow.id });
    }
    return fail(errorCode, errorMessage, 500, { requestId });
  }

  void audit({
    action: "ai_agent.tested",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent_version",
    resourceId: vid,
    requestId,
    metadata: { run_id: runRow.id, dry_run: true },
  });

  return ok(resultPayload, { requestId });
}

interface StubArgs {
  runId: string;
  orgId: string;
  versionId: string;
  sampleMessage: string;
  sampleContact?: { name?: string; phone?: string };
  version: {
    system_prompt: string;
    provider: string;
    model: string;
    channel_session_id: string;
    tool_ids: unknown;
  };
  startedAt: Date;
}

async function runStubbedTest(args: StubArgs): Promise<Record<string, unknown>> {
  const finishedAt = new Date();
  const latencyMs = finishedAt.getTime() - args.startedAt.getTime();

  // Trace fake plausível pra UI testar render. Nada disso é executado.
  const toolCalls = [
    {
      step: 1,
      tool_name: "(stub)",
      args: { sample_message: args.sampleMessage },
      result: {
        ok: true,
        note: "INTERNAL_AGENT_RUN_STUB=true — execução demonstrativa, sem chamar o modelo.",
      },
      started_at: args.startedAt.toISOString(),
      ended_at: finishedAt.toISOString(),
    },
  ];

  const finalText = `[STUB] Resposta simulada para "${args.sampleMessage.slice(0, 80)}".`;

  const admin = createAdminClient();
  const { error } = await admin
    .from("ai_agent_runs")
    .update({
      status: "completed",
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
      latency_ms: latencyMs,
      steps_count: 1,
      tool_calls: toolCalls,
      completed_at: finishedAt.toISOString(),
    })
    .eq("id", args.runId)
    .eq("organization_id", args.orgId);
  if (error) throw new Error("test_run_persist_failed");

  return {
    run_id: args.runId,
    status: "completed",
    final_text: finalText,
    // O stub também passa pela avaliação: um caminho que não a tivesse voltaria
    // a ser o "verde que não olhou para nada" — só que mais difícil de notar,
    // porque conviveria com um caminho que olha.
    guardrails: avaliarRespostaDeTeste(finalText),
    tool_calls: toolCalls,
    tokens_in: 0,
    tokens_out: 0,
    cost_cents: 0,
    latency_ms: latencyMs,
    would_send_to: {
      session: args.version.channel_session_id,
      chat_id: args.sampleContact?.phone ?? null,
    },
    stub: true,
  };
}

async function callInternalRuntime(args: {
  runId: string;
  agentId: string;
  orgId: string;
  versionId: string;
  sampleMessage: string;
  sampleContact?: { name?: string; phone?: string };
  history?: Array<{ direction: "inbound" | "outbound"; body: string }>;
}): Promise<Record<string, unknown>> {
  const { getRequestPool } = await import("@/lib/agent-engine/db/request-pool");
  const { loadAgentConfigForTest } = await import("@/lib/agent-engine/agent/agent-config");
  const { testConversation } = await import("@/lib/agent-engine/agent/test-conversation");
  const { llmEdgeConfigFromEnv } = await import("@/lib/agent-engine/edge/llm/run-model-call");
  const pool = getRequestPool();
  const agent = await loadAgentConfigForTest(pool, args.orgId, args.agentId, args.versionId);
  if (!agent) throw new Error("agent_version_not_found");
  const result = await testConversation(pool, llmEdgeConfigFromEnv(env), {
    organizationId: args.orgId,
    agent,
    message: args.sampleMessage,
    contact: args.sampleContact,
    history: args.history,
  });
  const { error } = await createAdminClient()
    .from("ai_agent_runs")
    .update({
      status: result.status,
      tool_calls: result.tool_calls,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      cost_cents: result.cost_cents,
      latency_ms: result.latency_ms,
      steps_count: result.tool_calls.length,
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.runId)
    .eq("organization_id", args.orgId);
  if (error) throw new Error("test_run_persist_failed");
  const guardrails = avaliarRespostaDeTeste(result.final_text);
  return {
    ...result,
    run_id: args.runId,
    stub: false,
    guardrails: {
      ...guardrails,
      passou: Boolean(result.final_text.trim()) && guardrails.passou,
      semResposta: !result.final_text.trim(),
      naoAvaliados: result.limitations,
    },
  };
}
