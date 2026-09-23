/**
 * GET  /api/v1/automation-rules — lista as regras de automação da org ativa.
 * POST /api/v1/automation-rules — cria uma regra. is_active NUNCA aceito no
 *   create (schema não tem o campo) — regra nasce pausada (default FALSE do banco).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAutomationRuleSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";
import {
  chaveDeIdempotencia,
  concluirIdempotencia,
  hashCanonico,
  idRecurso,
  reservarOuReplay,
} from "@/lib/api/idempotency";

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/v1/automation-rules";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041).
  const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
  if (safeActions === null) {
    return fail(
      "encryption_unavailable",
      "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a ação sem segredo.",
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  const admin = createAdminClient();

  const idempotencyKey = req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  const insertPayload = {
    organization_id: activeOrg.orgId,
    created_by_user_id: user.id,
    name: parsed.data.name,
    trigger_event: parsed.data.trigger_event,
    conditions: parsed.data.conditions,
    actions: safeActions,
  };

  let created;
  if (idempotencyKey) {
    const chave = chaveDeIdempotencia(user.id, idempotencyKey);
    const hash = hashCanonico(parsed.data);
    const recursoId = idRecurso(activeOrg.orgId, user.id, ENDPOINT, idempotencyKey);

    // Reserva a identidade + hash ANTES de criar a regra.
    const reserva = await reservarOuReplay(admin, {
      organizationId: activeOrg.orgId,
      endpoint: ENDPOINT,
      chave,
      hash,
      recursoId,
    });
    if (reserva.tipo === "conflito") {
      return fail("idempotency_conflict", "Requisicão repetida com conteúdo divergente.", 409, {
        requestId,
      });
    }

    // ID determinístico: retry/replay/concorrência colide no PRIMARY KEY e
    // devolve a MESMA regra (que continua nascendo pausada) — nunca uma segunda.
    const { data: nova, error: insErr } = await supabase
      .from("automation_rules")
      .insert({ ...insertPayload, id: recursoId, metadata: { idempotency_key: chave, idempotency_hash: hash } })
      .select("*")
      .single();
    if (insErr?.code === "23505") {
      const { data: existenteRegra } = await supabase
        .from("automation_rules")
        .select("*")
        .eq("id", recursoId)
        .eq("organization_id", activeOrg.orgId)
        .single();
      if (!existenteRegra) {
        return fail("internal_error", "Regra esperada não encontrada no replay.", 500, { requestId });
      }
      // O hash original fica na PRÓPRIA regra: hash diferente é 409, nunca replay.
      const existingHash = (existenteRegra as { metadata?: Record<string, unknown> }).metadata?.idempotency_hash;
      if (existingHash !== hash) {
        return fail("idempotency_conflict", "Requisicão repetida com conteúdo divergente.", 409, { requestId });
      }
      created = existenteRegra;
    } else if (insErr || !nova) {
      return fail("internal_error", insErr?.message ?? "automation_rule_insert_failed", 500, { requestId });
    } else {
      created = nova;
    }

    await concluirIdempotencia(admin, {
      organizationId: activeOrg.orgId,
      endpoint: ENDPOINT,
      chave,
      recursoId,
      statusCode: 201,
    });
  } else {
    const { data: nova, error: insErr } = await supabase
      .from("automation_rules")
      .insert(insertPayload)
      .select("*")
      .single();
    if (insErr || !nova) {
      return fail("internal_error", insErr?.message ?? "automation_rule_insert_failed", 500, { requestId });
    }
    created = nova;
  }

  void audit({
    action: "automation.rule_created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name, trigger_event: parsed.data.trigger_event },
  });

  return ok(created, { requestId, status: 201 });
}
