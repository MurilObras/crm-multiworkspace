import type { ActionCtx, ActionResultDetail } from "./types";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";

export async function readEventPlan<T>(db: Queryable, org: string, event: string): Promise<T[] | null> {
  const {rows}=await db.query<{rules:T[]}>("select rules from automation_event_plans where organization_id=$1 and event_id=$2",[org,event]);
  return rows[0]?.rules ?? null;
}

export async function freezeEventPlan<T>(db: Queryable, org: string, event: string, rules: T[]): Promise<T[]> {
  await db.query(`insert into automation_event_plans(organization_id,event_id,rules)
    select organization_id,id,$3::jsonb from event_log where organization_id=$1 and id=$2
    on conflict(organization_id,event_id) do nothing`,[org,event,JSON.stringify(rules)]);
  // Outro adquirente pode ter vencido. A leitura após o INSERT enxerga seu commit.
  const saved=await readEventPlan<T>(db,org,event);
  if(saved===null)throw new Error("automation_plan_unavailable");
  return saved;
}

/** Fence curto, compartilhado com a anonimização; nunca envolve transporte. */
export async function actionPlanLive(db: Queryable, org: string, event: string): Promise<boolean> {
  const { rows } = await db.query<{ live: boolean }>(
    "select fn_automation_plan_live($1,$2) live", [org,event]);
  return rows[0]?.live === true;
}

/** Passos que assumem a conversa só avançam após os anteriores concluírem. */
export async function precedingActionsState(db: Queryable, org: string, event: string, rule: string, index: number): Promise<"ready" | "waiting" | "failed"> {
  if (index === 0) return "ready";
  const { rows } = await db.query<{ status: string; execution_state: string }>(
    "select status,execution_state from automation_rule_runs where organization_id=$1 and event_id=$2 and rule_identity=$3 and action_index < $4",
    [org, event, rule, index],
  );
  if (rows.some(r => r.status === "failed" || ["uncertain", "rejected", "blocked", "failed_before_send"].includes(r.execution_state))) return "failed";
  return rows.length === index && rows.every(r => r.status === "success") ? "ready" : "waiting";
}

/** A intenção usa o histórico existente. INSERT/UNIQUE é a aquisição; nenhuma
 * transação permanece aberta durante a execução da ação ou chamada externa.
 * Uma intenção adquirida nunca volta a ser adquirível por retry do evento.
 */
export async function acquireActionIntent(db: Queryable, ctx: Pick<ActionCtx,"organizationId" | "ruleId" | "event">, index: number, type: string, planned=false) {
  const { rows } = await db.query<{ id: string }>(`
    insert into automation_rule_runs
      (organization_id,rule_id,rule_identity,event_id,action_index,status,execution_state,execution_updated_at,actions_result)
    select $1,r.id,$2::uuid,e.id,$4::integer,'adiado','preparing',now(),$5::jsonb
    from event_log e left join automation_rules r on r.organization_id=e.organization_id and r.id=$2
    where e.id=$3 and e.organization_id=$1 and (
      (not $6::boolean and r.is_active) or ($6::boolean and exists(
        select 1 from automation_event_plans p,jsonb_array_elements(p.rules) plan
        where p.organization_id=$1 and p.event_id=$3 and plan->>'id'=$2::text
          and plan->'actions'->($4::integer)->>'type'=$7)))
    on conflict (organization_id,event_id,rule_identity,action_index) where action_index is not null
    do nothing returning id`, [ctx.organizationId, ctx.ruleId, ctx.event.id, index,
      JSON.stringify([{ type, status: "postponed", detail: { reason: "awaiting_processing" } }]),planned,type]);
  return rows[0]?.id ?? null;
}

export async function finishActionIntent(db: Queryable, org: string, id: string, result: ActionResultDetail) {
  // Erros livres e texto gerado não são copiados para o histórico durável.
  const reason = result.detail?.reason ?? result.detail?.error_code ?? result.error;
  const knownReasons = ["no_contact", "no_phone", "contact_blocked", "contact_anonymized", "consent_declined",
    "missing_config", "invalid_config", "flow_not_active", "live_enrollment_exists", "sem_agente_publicado", "ia_indisponivel",
    "recipient_changed", "awaiting_processing", "fora_da_janela_de_envio", "daily_limit", "outbound_delivery_uncertain",
    "template_not_found", "template_not_approved", "template_lookup_failed", "template_missing_values", "template_invalid_values", "outbound_session_unavailable"];
  const safeReason = typeof reason === "string" && knownReasons.includes(reason)
    ? reason : result.status === "success" ? (result.detail?.message_id ? "provider_accepted" : "action_completed") : "action_failed";
  const state = result.status === "skipped" ? "blocked"
    : result.status === "failed" ? "failed_before_send"
    : result.status === "postponed" ? "pending" : "completed";
  await db.query(`update automation_rule_runs set
    status=$3, execution_state=case when execution_state in ('preparing','pending') then $4 else execution_state end,
    actions_result=$5::jsonb, execution_updated_at=now()
    where organization_id=$1 and id=$2 and action_index is not null`,
  [org,id,result.status === "success" ? "success" : result.status === "postponed" ? "adiado" : "failed",
    state,JSON.stringify([{ type: result.type, status: result.status, detail: { reason: safeReason } }])]);
  if (result.status !== "success") void audit({ action:"automation.rule_executed",organizationId:org,
    resourceType:"automation_rule_run",resourceId:id,metadata:{status:result.status,reason:safeReason} });
}

/** Usa o mesmo prazo do watchdog de mensagens. Não retoma nem reenvia.
 * A fase started é prova de possibilidade, não prova de entrega.
 */
export async function expireActionIntents(db: Queryable) {
  return db.query(`update automation_rule_runs set status='failed',
    execution_state=case when execution_state='sending' then 'uncertain' else 'failed_before_send' end,
    execution_updated_at=now()
    where action_index is not null and execution_state in ('preparing','sending')
      and execution_updated_at < now()-interval '5 minutes' returning id`);
}

/** O cron existente não passa a exigir conexão SQL direta só para expirar runs. */
export async function expireActionIntentsViaApi(db: SupabaseClient, now: Date) {
  let count = 0;
  for (const [from,to] of [["preparing","failed_before_send"],["sending","uncertain"]]) {
    const { data,error } = await db.from("automation_rule_runs")
      .update({ status:"failed",execution_state:to,execution_updated_at:now.toISOString() })
      .eq("execution_state",from).lt("execution_updated_at",new Date(now.getTime()-5*60*1000).toISOString())
      .select("id");
    if (error) throw new Error("automation_expiry_failed");
    count += data?.length ?? 0;
  }
  return count;
}
