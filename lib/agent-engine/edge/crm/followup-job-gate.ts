import type { Queryable } from '../../queue/queue';
import { OutboundLeaseLostError } from '@/lib/channels/delivery-error';

/** Pausa conserva a intenção preparada; término/nó antigo a descarta. A grace
 * da retomada vale também para um job criado antes de o humano assumir. */
export async function followupJobGate(db: Queryable, org: string, job: string, contact: string | null, worker?: string) {
  const { rows } = await db.query<{ allowed: boolean; owned: boolean; retry_at: Date | string | null }>(
    `select public.fn_followup_job_live($1,$2,$3) as allowed,
       (j.status='running' and ($4::text is null or j.locked_by=$4)) as owned,
       case when e.current_node_id is distinct from j.payload->>'node_id'
         or (j.payload->>'node_epoch' is not null and e.node_epoch<>(j.payload->>'node_epoch')::integer) then null
         when e.status in ('paused_manual','paused_handoff') then now()+interval '1 minute'
         when e.status in ('active','waiting_reply') then (
           select max(coalesce((ev.payload->>'next_eval_at')::timestamptz,ev.created_at+interval '30 minutes'))
           from followup_enrollment_events ev where ev.organization_id=$1 and ev.enrollment_id=e.id and ev.node_id=e.current_node_id
             and ev.event_type in ('handoff_resumed','resumed_manual','snoozed_manual') and ev.created_at>j.created_at
             and coalesce((ev.payload->>'next_eval_at')::timestamptz,ev.created_at+interval '30 minutes')>now())
         else null end as retry_at
     from job_queue j left join followup_enrollments e
       on e.id::text=j.payload->>'followup_enrollment_id' and e.organization_id=j.organization_id and e.contact_id=j.contact_id
     where j.id=$2 and j.organization_id=$1 and j.contact_id is not distinct from $3`, [org, job, contact, worker ?? null]);
  if (!rows[0]?.owned) throw new OutboundLeaseLostError();
  return { allowed: rows[0].allowed === true,
    retryAt: rows[0].retry_at ? new Date(rows[0].retry_at) : null };
}
