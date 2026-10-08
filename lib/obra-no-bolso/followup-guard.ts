import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshSubscriptionState } from "./subscription-lookup";
import { nextObraProactiveWindow } from "./subscription-event";

/** A consulta só ocorre para follow-up de contato vinculado ao contrato v2. */
export async function guardObraFollowup(db: Queryable, org: string, jobId: string, contact: string): Promise<
  { allowed: true } | { allowed: false; retryAt?: Date }> {
  const { rows } = await db.query<{ state_id: string; enabled: boolean }>(`select s.id state_id, (i.is_active and i.outreach_enabled) enabled from obra_subscription_states s
    join obra_access_integrations i on i.organization_id=s.organization_id and i.id=s.integration_id
    join job_queue j on j.organization_id=s.organization_id and j.contact_id=s.contact_id
    where s.organization_id=$1 and s.contact_id=$3 and j.id=$2 and j.kind='followup_turn' and i.lifecycle_enabled`, [org,jobId,contact]);
  const state = rows[0];
  if (!state) return { allowed: true };
  if (!state.enabled) return { allowed: false };
  const window = nextObraProactiveWindow(new Date());
  if (window) return { allowed: false, retryAt: window };
  await refreshSubscriptionState(createAdminClient(), org, state.state_id);
  const { rows: live } = await db.query<{ live: boolean }>("select fn_obra_followup_live($1,$2,$3) live", [org,jobId,contact]);
  return live[0]?.live === true ? { allowed: true } : { allowed: false };
}
