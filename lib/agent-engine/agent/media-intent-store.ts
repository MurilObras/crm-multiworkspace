import {
  OutboundLeaseLostError,
  OutboundAudioUnavailableError,
} from "@/lib/channels/delivery-error";
import type { ApprovedMedia } from "@/lib/ai/agents/approved-media";
import type { MediaReplayPolicy } from "@/lib/ai/agents/media-replay-policy";
import type { JobRow, Queryable } from "../queue/queue";
import { pendingAudioSubject } from "./audio-rule";
import {
  mediaApprovalHash,
  mediaDecisionSchema,
  mediaSubjectHash,
  type MediaDecision,
  type MediaIntent,
} from "./media-intent";

/** A prova não vem dos argumentos da ferramenta. É lida do job sob o escopo da conversa. */
export async function loadTurnMediaDecision(
  db: Queryable,
  org: string,
  conversation: string,
  agent: string,
  job: string,
): Promise<MediaDecision | null> {
  const { rows } = await db.query<{ decision: unknown; inbound: string }>(
    `select payload->'media_intent_decision' as decision,payload->>'inbound_message_id' as inbound
     from job_queue where organization_id=$1 and id=$2 and kind='inbound_turn' and status='running'
       and payload->>'conversation_id'=$3`,
    [org, job, conversation],
  );
  const parsed = mediaDecisionSchema.safeParse(rows[0]?.decision);
  if (!parsed.success || !rows[0]) {
    if (rows[0]?.decision != null)
      throw new OutboundAudioUnavailableError("audio_approval_revoked");
    return null;
  }
  const d = parsed.data;
  if (
    d.organization_id !== org ||
    d.agent_id !== agent ||
    d.conversation_id !== conversation ||
    d.inbound_message_id !== rows[0].inbound
  )
    throw new OutboundAudioUnavailableError("audio_approval_revoked");
  const subject = await pendingAudioSubject(db, org, conversation, job, d.inbound_message_id);
  if (d.subject_sha256 !== mediaSubjectHash(subject))
    throw new OutboundAudioUnavailableError("audio_approval_revoked");
  return d;
}

export async function persistTurnMediaDecision(args: {
  db: Queryable;
  job: JobRow;
  worker: string;
  agent: string;
  conversation: string;
  inbound: string;
  subject: string;
  policy: MediaReplayPolicy;
  intent: MediaIntent;
  authorize: (decision: MediaDecision) => Promise<ApprovedMedia[]>;
  selected: ApprovedMedia | null;
  blockReason?: () => string;
  noMatchReason?: string;
  resolutionSource?: 'explicit_reference' | 'text_preference' | 'classifier';
}): Promise<MediaDecision> {
  const decision: MediaDecision = {
    ...args.intent,
    version: 1,
    organization_id: args.job.organization_id,
    agent_id: args.agent,
    conversation_id: args.conversation,
    inbound_message_id: args.inbound,
    subject_sha256: mediaSubjectHash(args.subject),
    policy: args.policy,
    authorized_id: null,
    reason: "no_matching_media",
    selected_title: args.selected?.title ?? null,
    approval_sha256: args.selected ? mediaApprovalHash(args.selected) : null,
  };
  const permitted = await args.authorize(decision);
  decision.authorized_id = permitted.some((m) => m.id === decision.audio_id)
    ? decision.audio_id
    : null;
  decision.reason = decision.text_only
    ? "text_preference"
    : decision.authorized_id
      ? "authorized"
      : decision.audio_id
        ? (args.blockReason?.() ?? "stage_not_permitted")
        : (args.noMatchReason ?? "no_matching_media");
  const { rows } = await args.db.query<{ decision: unknown }>(
    `update job_queue set payload=coalesce(payload,'{}'::jsonb) || jsonb_build_object('media_intent_decision',$5::jsonb,
       'media_resolution_source',$8::text)
     where id=$1 and organization_id=$2 and contact_id is not distinct from $3 and status='running' and locked_by=$4
       and payload->>'conversation_id'=$6 and payload->>'inbound_message_id'=$7
       and not (payload ? 'media_intent_decision')
     returning payload->'media_intent_decision' as decision`,
    [
      args.job.id,
      args.job.organization_id,
      args.job.contact_id,
      args.worker,
      JSON.stringify(decision),
      args.conversation,
      args.inbound,
      args.resolutionSource ?? 'classifier',
    ],
  );
  if (!rows[0]) throw new OutboundLeaseLostError();
  return mediaDecisionSchema.parse(rows[0].decision);
}
