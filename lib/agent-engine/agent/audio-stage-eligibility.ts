import type { Queryable } from '../queue/queue';
import type { ApprovedAudio } from '@/lib/ai/agents/approved-audios';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';

/** Funil real, não a máquina genérica lead_state; empates nunca liberam áudio. */
export async function eligibleAudiosForContact(
  db: Queryable, org: string, contact: string | null, audios: ApprovedAudio[],
): Promise<ApprovedAudio[]> {
  if (!audios.some(a => a.stage_ids.length)) return audios;
  if (!contact) return audios.filter(a => !a.stage_ids.length);
  const { rows } = await db.query<LeadCandidate & { stage_id: string; stage_active: boolean }>(
    `select l.id,l.organization_id,l.pipeline_id,l.status,l.stage_id,l.last_activity_at,l.created_at,
            (p.id is not null and s.id is not null and not p.is_archived and not s.is_archived) as stage_active
       from crm_leads l
       left join crm_pipelines p on p.id=l.pipeline_id and p.organization_id=l.organization_id
       left join crm_stages s on s.id=l.stage_id and s.pipeline_id=l.pipeline_id and s.organization_id=l.organization_id
      where l.organization_id=$1 and l.contact_id=$2`, [org, contact],
  );
  const resolution = resolveActiveLeadForContact(rows);
  let current = resolution.routed ? rows.find(l => l.id === resolution.leadId) : undefined;
  // Encerramentos também têm etapas (ex.: venda ganha). Só usar o último sem empate.
  if (!resolution.routed && resolution.reason === 'no_open_lead') {
    const activity = (l: LeadCandidate) => new Date(l.last_activity_at ?? l.created_at).getTime();
    const ordered = [...rows].sort((a, b) => activity(b) - activity(a));
    if (ordered[0] && (!ordered[1] || activity(ordered[0]) > activity(ordered[1]))) current = ordered[0];
  }
  return audios.filter(a => !a.stage_ids.length || (current?.stage_active && a.stage_ids.includes(current.stage_id)));
}
