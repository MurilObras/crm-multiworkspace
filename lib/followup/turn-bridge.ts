/**
 * Ponte engine ⇄ job_queue (Task 5.1, onda 5). Traduz o RESULTADO de um turno
 * `followup_turn` do agent-engine (lib/agent-engine/agent/followup-turn.ts) de
 * volta em progressão de enrollment — o lado followup sabe ler o grafo pinado e
 * escolher a aresta certa; o agent-engine só sabe QUE o turno terminou e chama
 * de volta aqui via callback injetado (a ponte nunca importa nada de
 * agent-engine — a dependência é numa direção só).
 *
 * Espelha o pattern de `engine.ts`: lógica pura (clampProposedAt) + interface
 * estreita de DB (TurnBridgeAdminClient, superset de AdminClient) + adapter de
 * produção (createPgAdminClient — o worker 24/7 fala `pg` puro, não Supabase;
 * ver `createSupabaseAdminClient` em engine.ts pro equivalente REST usado pela
 * rota de cron).
 */
import type pg from "pg";

import type { AdminClient, EnrollmentPatch } from "./engine";
import { flowGraphSchema } from "./graph-schema";
import { classEdgeMatch, selectEdge, type EnrollmentRow } from "./node-handlers";
import { coletarEsperasAdaptativas, montarTimingPlan, type PropostaDeEspera } from "./timing-plan";
import { persistirRespostaFollowupPg } from "./persistir-resposta";

/** Superset de AdminClient: a ponte precisa do snapshot COMPLETO do enrollment
 *  (current_node_id/version_id/steps_taken) pra montar o passo de conclusão —
 *  algo que AdminClient não tinha (só claim em lote). Extensão isolada aqui
 *  (não no AdminClient do engine) pra não obrigar o adapter pg-puro já
 *  aprovado em tests/invariants/followup-engine.test.ts a ganhar um método
 *  que ele não usa (HANDOFF Decisões — AdminClient é interface própria e
 *  estreita por consumidor). */
export interface TurnBridgeAdminClient extends AdminClient {
  loadEnrollmentById(orgId: string, id: string): Promise<EnrollmentRow | null>;
  /** Evento e avanço sob o mesmo lock/CAS; a intervenção posterior ao snapshot vence. */
  completeStep(enrollment: EnrollmentRow, event: {
    node_id: string; event_type: string; payload: Record<string, unknown>; idempotency_key: string;
  }, patch: EnrollmentPatch): Promise<boolean>;
}

/** Resultado de um turno `followup_turn` dirigido por fluxo, por `purpose`. */
export type TurnResult =
  | { kind: "sent" }
  | { kind: "classified"; class: string }
  /** Plano de tempo do fluxo inteiro, proposto no acionamento — cru, antes do clamp. */
  | { kind: "planned"; propostas: PropostaDeEspera[]; modelo: string };

/**
 * Traduz o resultado de um turno concluído em progressão do enrollment —
 * idempotente por `${node_id}:${steps_taken}` (mesma doutrina de
 * `applyResult` em engine.ts): uma 2ª chamada para o MESMO passo (ex.: job
 * retentado após o ack se perder) bate 23505 no insert do evento e vira no-op,
 * nunca avança/duplica.
 *
 * Desvio deliberado da assinatura esboçada no plano
 * (`completeTurnForEnrollment(db, enrollmentId, result)`): adiciona `orgId`
 * (toda escrita do AdminClient é org-scoped — CLAUDE.md, service role nunca
 * sem filtro manual) e `nodeId` (o node_id que o PAYLOAD do job carregava,
 * não o current_node_id lido agora) — serve de guarda de obsolescência: se o
 * enrollment já saiu desse nó por outro caminho enquanto o turno rodava
 * (ex.: cancelamento), a conclusão tardia vira no-op silencioso em vez de
 * reaplicar sobre o nó errado.
 */
export async function completeTurnForEnrollment(
  db: TurnBridgeAdminClient,
  orgId: string,
  enrollmentId: string,
  nodeId: string,
  result: TurnResult,
  clock: () => Date = () => new Date(),
  occupation?: { key?: string; nodeEpoch?: number },
): Promise<void> {
  const enrollment = await db.loadEnrollmentById(orgId, enrollmentId);
  if (!enrollment) return; // enrollment sumiu (nunca deveria, mas nada a completar)
  if (enrollment.current_node_id !== nodeId) return; // turno tardio/obsoleto — o enrollment já saiu do nó
  if (occupation?.nodeEpoch !== undefined && enrollment.node_epoch !== occupation.nodeEpoch) return;
  // SÓ QUEM ESTÁ ANDANDO AVANÇA — lista positiva, e isso é o conserto.
  //
  // O guard nasceu excluindo completed/cancelled/dead e a Task 5.2 teve de
  // acrescentar `paused_handoff` depois, porque um turno em voo reativava por
  // baixo do `reactToHandoffClose`. Lista negativa tem esse modo de falha por
  // construção: todo estado NOVO entra por omissão, e o sintoma é silencioso —
  // o resultado stale (computado ANTES de o humano intervir) sobrescreve a
  // decisão da pessoa e o fluxo volta a andar sozinho.
  //
  // Aconteceu de novo com `paused_manual` (migration 0145): sem esta troca, um
  // envio que terminasse depois do clique desfazia a pausa em silêncio.
  // Resultado classificado/planejado é descartado na pausa. Um envio já
  // confirmado conserva somente a prova, sem avançar nem desfazer a pausa.
  if (enrollment.status !== "active" && enrollment.status !== "waiting_reply" &&
      !(result.kind === "sent" && (["paused_manual", "paused_handoff"].includes(enrollment.status) ||
        (enrollment.status === "cancelled" && enrollment.outcome === "replied" && enrollment.cancel_reason === "cancel_on_reply")))) return;

  const graph = await db.loadFlowGraph(orgId, enrollment.version_id);
  if (!graph) throw new Error("flow_version_not_found");
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("node_not_found");

  const now = clock();
  const idemKey = `${node.id}:${enrollment.steps_taken}`;

  const applyStep = async (
    eventType: string,
    payload: Record<string, unknown>,
    patch: EnrollmentPatch,
  ): Promise<void> => {
    await db.completeStep(enrollment, {
      node_id: node.id,
      event_type: eventType,
      payload: { ...payload, ...(occupation?.key ? { enrollment_action_key: occupation.key } : {}) },
      idempotency_key: idemKey,
    }, {
      ...patch,
      steps_taken: enrollment.steps_taken + 1,
      claimed_until: null,
      updated_at: now.toISOString(),
    });
  };

  if (result.kind === "sent") {
    // match_reply (if_exists: confirm) enfileira a pergunta e permanece no nó.
    // Completar o envio não avança — a resposta do lead é que avança.
    // Lançar aqui devolvia o job pra pending e o pipeline mandava a pergunta de novo.
    if (node.type === "match_reply") return;
    if (node.type !== "action") {
      throw new Error(`completeTurnForEnrollment: resultado 'sent' mas o nó "${node.id}" não é 'action'`);
    }
    const edge = selectEdge(graph.edges, node.id, { type: "always" });
    if (!edge) throw new Error(`action node "${node.id}" sem aresta 'always' de saída`);
    await applyStep(
      "action_sent",
      {},
      { current_node_id: edge.target, status: "active", next_eval_at: now.toISOString() },
    );
    return;
  }

  if (result.kind === "classified") {
    if (node.type !== "ai_classify") {
      throw new Error(`completeTurnForEnrollment: resultado 'classified' mas o nó "${node.id}" não é 'ai_classify'`);
    }
    const edge = selectEdge(graph.edges, node.id, classEdgeMatch(node, result.class));
    if (!edge) {
      throw new Error(`ai_classify node "${node.id}" sem aresta pra classe "${result.class}" (fallback 'always' também ausente)`);
    }
    await applyStep(
      "ai_classified",
      { class: result.class },
      { current_node_id: edge.target, status: "active", next_eval_at: now.toISOString() },
    );
    return;
  }

  // 'planned' — o acionamento decidiu os instantes de TODAS as esperas adaptativas.
  if (node.type !== "trigger") {
    throw new Error(`completeTurnForEnrollment: resultado 'planned' mas o nó "${node.id}" não é 'trigger'`);
  }
  // Clampa contra o GRAFO PINADO, nunca contra o que o payload do modelo afirma
  // que o intervalo era: quem propõe é a IA, quem decide o intervalo é o nó.
  const plano = montarTimingPlan({
    esperas: coletarEsperasAdaptativas(graph.nodes),
    propostas: result.propostas,
    modelo: result.modelo,
    agora: now,
  });
  const edge = selectEdge(graph.edges, node.id, { type: "always" });
  if (!edge) throw new Error(`trigger node "${node.id}" sem aresta 'always' de saída`);
  await applyStep(
    "timing_plan_decidido",
    // O plano inteiro no evento (não só um ponteiro pra coluna): a timeline do
    // enrollment precisa ser legível sozinha, com o motivo de cada espera.
    { ...plano },
    {
      current_node_id: edge.target,
      status: "active",
      next_eval_at: now.toISOString(),
      timing_plan: plano,
    },
  );
}

// ---------------------------------------------------------------------------
// Adapter de produção: TurnBridgeAdminClient falado em `pg` puro — o worker
// 24/7 (workers/agent-worker/main.ts) só tem um pg.Pool, nunca um SupabaseClient
// (esse é o mundo das rotas Next.js, ver createSupabaseAdminClient em
// engine.ts). SQL espelha 1:1 o adapter de teste já provado em
// tests/invariants/followup-engine.test.ts.
// ---------------------------------------------------------------------------

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapEnrollmentRow(row: Record<string, unknown>): EnrollmentRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    pointer_id: row.pointer_id as string,
    version_id: row.version_id as string,
    contact_id: row.contact_id as string,
    conversation_id: (row.conversation_id as string | null) ?? null,
    current_node_id: row.current_node_id as string,
    status: row.status as EnrollmentRow["status"],
    next_eval_at: toIso(row.next_eval_at),
    claimed_until: toIso(row.claimed_until),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    last_error: (row.last_error as string | null) ?? null,
    steps_taken: Number(row.steps_taken),
    node_epoch: row.node_epoch === undefined ? undefined : Number(row.node_epoch),
    outcome: (row.outcome as EnrollmentRow["outcome"]) ?? null,
    cancel_reason: (row.cancel_reason as string | null) ?? null,
    started_at: toIso(row.started_at)!,
    completed_at: toIso(row.completed_at),
    updated_at: toIso(row.updated_at)!,
    // `?? null` e não `as TimingPlan`: num clone sem a migration 0144 a chave
    // simplesmente não vem, e "sem plano" é exatamente o que null significa.
    timing_plan: row.timing_plan ?? null,
  };
}

/** `TurnBridgeAdminClient` sobre `pg.Pool` — produção do worker 24/7. */
export function createPgAdminClient(pool: Pick<pg.Pool, 'query'>): TurnBridgeAdminClient {
  return {
    async claimDueEnrollments(limit, leaseSeconds) {
      const { rows } = await pool.query(`select e.*,e.updated_at::text as updated_at from fn_claim_due_followup_enrollments($1, $2) e`, [
        limit,
        leaseSeconds,
      ]);
      return rows.map(mapEnrollmentRow);
    },
    async loadEnrollmentById(orgId, id) {
      const { rows } = await pool.query(
        `select *,updated_at::text as updated_at from followup_enrollments where id = $1 and organization_id = $2`,
        [id, orgId],
      );
      return rows[0] ? mapEnrollmentRow(rows[0] as Record<string, unknown>) : null;
    },
    async completeStep(enrollment, event, patch) {
      const { rows } = await pool.query<{ applied: boolean }>(
        `select public.fn_followup_complete_step($1,$2,$3,$4,$5) as applied`,
        [enrollment.organization_id, enrollment.id, JSON.stringify({ status: enrollment.status,
          current_node_id: enrollment.current_node_id, steps_taken: enrollment.steps_taken,
          updated_at: enrollment.updated_at, node_epoch: enrollment.node_epoch }), JSON.stringify(event), JSON.stringify(patch)],
      );
      return rows[0]?.applied === true;
    },
    async loadFlowGraph(orgId, versionId) {
      const { rows } = await pool.query<{ graph: unknown }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return flowGraphSchema.parse(rows[0]!.graph);
    },
    async loadLeadFacts(orgId, contactId) {
      const { rows: leads } = await pool.query<{
        stage_id: string | null;
        custom_fields: Record<string, unknown> | null;
      }>(
        `select stage_id, custom_fields from crm_leads where organization_id = $1 and contact_id = $2
         order by updated_at desc limit 1`,
        [orgId, contactId],
      );
      const { rows: contacts } = await pool.query<{ name: string | null; tags: string[] | null }>(
        `select name, tags from contacts where organization_id = $1 and id = $2`,
        [orgId, contactId],
      );
      const lead = leads[0];
      return {
        lead_stage: lead?.stage_id ?? null,
        // Mesma fonte da varredura de silêncio e do adapter Supabase, sem fallback ao cartão.
        tags: contacts[0]?.tags ?? [],
        contact_name: contacts[0]?.name ?? null,
        custom_fields: lead?.custom_fields ?? {},
      };
    },
    async loadLastInboundBody(orgId, contactId, _conversationId, naoAntesDe) {
      const params: unknown[] = [orgId, contactId];
      const desde = naoAntesDe ? "and sent_at >= $3" : "";
      if (naoAntesDe) params.push(naoAntesDe);
      const { rows } = await pool.query<{ body: string | null }>(
        `select body from messages
         where organization_id = $1 and contact_id = $2 and direction = 'inbound' ${desde}
         order by sent_at desc limit 1`,
        params,
      );
      const body = rows[0]?.body;
      return typeof body === "string" ? body : null;
    },
    async loadEnrollmentEvents(enrollmentId) {
      const { rows } = await pool.query(
        `select node_id, idempotency_key, event_type, payload from followup_enrollment_events where enrollment_id = $1 order by created_at asc`,
        [enrollmentId],
      );
      return rows;
    },
    async insertEnrollmentEvent(event) {
      try {
        await pool.query(
          `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [event.organization_id, event.enrollment_id, event.node_id, event.event_type, event.payload, event.idempotency_key],
        );
        return { inserted: true };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false };
        throw err;
      }
    },
    async updateEnrollment(id, orgId, patch, expected) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const setSql = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
      const values = entries.map(([, v]) => v);
      const n = entries.length + 3;
      const guard = expected ? ` and status=$${n} and current_node_id=$${n+1} and steps_taken=$${n+2} and updated_at=$${n+3}::timestamptz` : '';
      await pool.query(`update followup_enrollments set ${setSql} where id = $1 and organization_id = $2${guard}`, [
        id,
        orgId,
        ...values,
        ...(expected ? [expected.status, expected.current_node_id, expected.steps_taken, expected.updated_at] : []),
      ]);
    },
    async loadFlowPointerName(orgId, pointerId) {
      const { rows } = await pool.query<{ name: string }>(
        `select name from followup_flow_pointers where organization_id = $1 and id = $2`,
        [orgId, pointerId],
      );
      return rows[0]?.name ?? null;
    },
    async insertDeadInboxItem(item) {
      await pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'followup_dead', 'warn', $2, $3, 'followup_enrollment', $4)`,
        [item.organization_id, item.title, item.body, item.ref_id],
      );
    },
    async persistirRespostaFollowup(input) {
      await persistirRespostaFollowupPg((sql, params) => pool.query(sql, params), input);
    },
  };
}
