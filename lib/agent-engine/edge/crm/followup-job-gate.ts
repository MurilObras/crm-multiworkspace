import { nextInSendWindow, sendWindowSchema } from '@/lib/followup/send-window';
import type { Queryable } from '../../queue/queue';
import { OutboundLeaseLostError } from '@/lib/channels/delivery-error';

/** Reavalia no mesmo ritmo da pausa: uma nova decisão não fica presa ao
 * run_after antigo por dias. Não consome tentativas nem chama o modelo. */
export function followupRetryDelay(retryAt: Date | null, now = Date.now()): number {
  return Math.min(60_000, Math.max(1, retryAt ? retryAt.getTime() - now : 60_000));
}

/** Pausa conserva a intenção preparada; término/nó antigo a descarta. A grace
 * da retomada vale também para um job criado antes de o humano assumir. */
export async function followupJobGate(db: Queryable, org: string, job: string, contact: string | null, worker?: string) {
  const { rows } = await db.query<{ allowed: boolean; owned: boolean; retry_at: Date | string | null; db_now?: Date | string; flow_send_window?: unknown }>(
    `select (public.fn_followup_job_live($1,$2,$3) and (j.kind <> 'followup_turn' or not public.fn_responsible_waiting($1,$3))) as allowed,
       (j.status='running' and ($4::text is null or j.locked_by=$4)) as owned,
       case when j.kind='followup_turn' and public.fn_responsible_waiting($1,$3) then now()+interval '1 minute'
         when e.current_node_id is distinct from j.payload->>'node_id'
         or (j.payload->>'node_epoch' is not null and e.node_epoch<>(j.payload->>'node_epoch')::integer) then null
         when e.status in ('paused_manual','paused_handoff') then now()+interval '1 minute'
         when e.status in ('active','waiting_reply') then (
           select case when coalesce((ev.payload->>'next_eval_at')::timestamptz,ev.created_at+interval '30 minutes')>now()
             then coalesce((ev.payload->>'next_eval_at')::timestamptz,ev.created_at+interval '30 minutes') else null end
           from followup_enrollment_events ev where ev.organization_id=$1 and ev.enrollment_id=e.id and ev.node_id=e.current_node_id
             and ev.event_type in ('handoff_resumed','resumed_manual','snoozed_manual') and ev.created_at>j.created_at
           -- A última decisão vence, inclusive quando encurta/encerra a espera.
           order by ev.created_at desc,ev.id desc limit 1)
         else null end as retry_at, now() as db_now,
       case when e.silence_anchor_at is not null then (
         select n->'config'->'send_window' from followup_enrollment_events ev
         join followup_flow_versions v on v.organization_id=$1 and v.id=e.version_id,
           lateral jsonb_array_elements(v.graph->'nodes') n
         where ev.organization_id=$1 and ev.enrollment_id=e.id and n->>'id'=ev.node_id and n->>'type'='wait'
         order by ev.created_at desc,ev.id desc limit 1
       ) else null end as flow_send_window
     from job_queue j left join followup_enrollments e
       on e.id::text=j.payload->>'followup_enrollment_id' and e.organization_id=j.organization_id and e.contact_id=j.contact_id
     where j.id=$2 and j.organization_id=$1 and j.contact_id is not distinct from $3`, [org, job, contact, worker ?? null]);
  if (!rows[0]?.owned) throw new OutboundLeaseLostError();
  const row = rows[0];
  const retryAt = row.retry_at ? new Date(row.retry_at) : null;
  // Retomar uma ação já preparada não pode pular a janela da espera que a
  // liberou. A mesma barreira roda antes do modelo e imediatamente antes da
  // rede, inclusive se o worker atrasou ou o canal ficou offline no fim de semana.
  if (row.allowed && row.flow_send_window != null) {
    const parsed = sendWindowSchema.safeParse(row.flow_send_window);
    if (!parsed.success) throw new Error('followup_window_invalid');
    const now = row.db_now ? new Date(row.db_now) : new Date();
    const next = nextInSendWindow(now,parsed.data);
    if (next > now) return { allowed:false,retryAt:retryAt && retryAt>next ? retryAt : next };
  }
  return { allowed:row.allowed === true,retryAt };
}
