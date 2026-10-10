import type { Queryable } from '../queue/queue';
import { audioPathOwnedBy, readApprovedAudios } from '@/lib/ai/agents/approved-audios';
import { OutboundApprovalRevokedError, OutboundAudioUnavailableError } from '@/lib/channels/delivery-error';
import { eligibleAudiosForContact } from './audio-stage-eligibility';

export async function assertAudioStillApproved(
  pool: Queryable, org: string, agent: string, audioId: string, contact: string | null,
): Promise<void> {
  const { rows } = await pool.query<{ config: unknown }>(
    'select config from ai_agents where id=$1 and organization_id=$2 and archived_at is null', [agent, org],
  );
  const active = readApprovedAudios(rows[0]?.config).find(a => a.id === audioId && a.enabled && audioPathOwnedBy(a, org, agent));
  if (!active) throw new OutboundApprovalRevokedError();
  if (!(await eligibleAudiosForContact(pool, org, contact, [active])).length) {
    throw new OutboundAudioUnavailableError('audio_stage_mismatch');
  }
}
