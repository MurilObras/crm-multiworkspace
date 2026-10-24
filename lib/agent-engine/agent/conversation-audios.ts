import type { Queryable } from '../queue/queue';
import type { ApprovedMedia as ApprovedAudio } from '@/lib/ai/agents/approved-media';
import { mediaKind } from '@/lib/ai/agents/approved-media';
import { conversationAllowsAudio } from './audio-preference';
import { explicitMediaPreference, conversationAllowsMedia, refersToPreviousMedia, requestsMediaReplay, withTurnMediaPreference } from './media-preference';
import { OutboundAudioUnavailableError } from '@/lib/channels/delivery-error';
import { pendingAudioMessages } from './audio-rule';
import { authorizeMediaIntent, mediaApprovalHash, type MediaDecision } from './media-intent';
import { loadTurnMediaDecision } from './media-intent-store';
import { readMediaReplayPolicy } from '@/lib/ai/agents/media-replay-policy';

// Inclui pendência e incerteza: falta de confirmação não autoriza outra cópia.
const HELD = `(m.external_id is not null or m.status in ('sent','delivered','read','sending')
  or m.metadata->'outbound_attempt'->>'phase' in ('started','uncertain','confirmed')
  or (m.status in ('queued','failed') and m.metadata->'outbound_attempt'->>'phase'='prepared'
      and coalesce(m.metadata->'outbound_attempt'->>'retryable','true')<>'false'))`;

export { explicitAudioPreference, conversationAllowsAudio } from './audio-preference';

interface HeldMedia {
  audio_id: string; agent_id: string; fingerprint: string | null; job_id: string | null;
  request_id: string | null; status: string; phase: string | null; id: string;
  kind: string;
}

async function history(db: Queryable, org: string, conversation: string): Promise<HeldMedia[]> {
  const { rows } = await db.query<HeldMedia>(
    `select m.id,coalesce(m.metadata->'approved_media'->>'media_id',m.metadata->'approved_audio'->>'audio_id') as audio_id,
      coalesce(m.metadata->'approved_media'->>'agent_id',m.metadata->'approved_audio'->>'agent_id') as agent_id,
      coalesce(m.metadata->'approved_media'->>'fingerprint',m.metadata->'approved_audio'->>'fingerprint',m.metadata->>'agent_media_fingerprint') as fingerprint,
      coalesce(m.metadata->'approved_media'->>'request_inbound_id',m.metadata->'approved_audio'->>'request_inbound_id') as request_id,
      m.status,m.type as kind,m.metadata->'outbound_attempt'->>'phase' as phase,l.job_id
     from messages m left join send_ledger l on l.organization_id=m.organization_id and l.id::text=m.metadata->>'idempotency_key'
     where m.organization_id=$1 and m.conversation_id=$2 and m.direction='outbound'
       and m.metadata->>'reconciled_into_message_id' is null
       and m.type in ('audio','image','video') and ${HELD}
       order by coalesce(m.sent_at,m.created_at) desc,m.created_at desc,m.id desc`, [org,conversation]);
  return rows;
}

export async function recentTurnMediaIds(db: Queryable, org: string, conversation: string, job: string, agent: string, catalog: ApprovedAudio[]): Promise<string[]> {
  return (await history(db,org,conversation)).filter(p => p.job_id !== job && ['sent','delivered','read'].includes(p.status) && p.phase !== 'uncertain')
    .flatMap(p => catalog.filter(m => m.id === p.audio_id && p.agent_id === agent || !!m.content_sha256 && m.content_sha256 === p.fingerprint).map(m => m.id)).slice(0,10);
}

/** A mesma mídia gerenciada não ganha outra entrega por troca de ID por URL. */
export async function assertRawMediaNotPreviouslyManaged(db: Queryable, org: string, conversation: string, fingerprint: string, own: string) {
  const { rows } = await db.query(`select m.id from messages m where m.organization_id=$1 and m.conversation_id=$2
    and m.direction='outbound' and m.id<>$4
    and coalesce(m.metadata->'approved_media'->>'fingerprint',m.metadata->'approved_audio'->>'fingerprint')=$3
    and ${HELD} limit 1`,[org,conversation,fingerprint,own]);
  if (rows.length) throw new OutboundAudioUnavailableError('audio_already_used');
}

async function requestText(db: Queryable, org: string, conversation: string, inbound: string | null, job?: string, semantic = false): Promise<string> {
  if (!inbound) return '';
  if (job) {
    const messages = await pendingAudioMessages(db,org,conversation,job,inbound);
    if (semantic) return [messages.at(-1)?.body,messages.at(-1)?.media_derived_text].filter(Boolean).join('\n');
    let latest = '';
    for (const message of messages) {
      const text = [message.body,message.media_derived_text].filter(Boolean).join('\n');
      if ((['audio','image','video'] as const).some(k => explicitMediaPreference(text,k) !== null)) latest = text;
    }
    return latest;
  }
  const { rows } = await db.query<{ body: string | null; media_derived_text: string | null }>(
    `select body,media_derived_text from messages where organization_id=$1 and conversation_id=$2 and id=$3 and direction='inbound'`,
    [org,conversation,inbound]);
  return [rows[0]?.body,rows[0]?.media_derived_text].filter(Boolean).join('\n');
}

function permitted(m: ApprovedAudio, prior: HeldMedia[], agent: string, inbound: string | null, text: string, decision?: MediaDecision | null): boolean {
  if (decision) return authorizeMediaIntent({ item: m, intent: decision, policy: decision.policy,
    legacyRequest: explicitMediaPreference(text,mediaKind(m)) === 'audio', allowsFormat: true, inbound,
    used: prior.filter(p => p.agent_id === agent || !!m.content_sha256 && p.fingerprint === m.content_sha256)
      .map(p => ({ id: p.audio_id, fingerprint: p.fingerprint, confirmed: ['sent','delivered','read'].includes(p.status) && p.phase !== 'uncertain', request: p.request_id })),
  }).allowed;
  const used = prior.filter(p => p.agent_id === agent && p.audio_id === m.id
    || !!m.content_sha256 && p.fingerprint === m.content_sha256);
  if (requestsMediaReplay(text, mediaKind(m)) && !used.length) return false;
  if (!used.length) return true;
  // Preferir um formato é pedido explícito de mídia; repetir apenas o assunto não é.
  if (!m.allow_requested_repeat || !inbound || explicitMediaPreference(text,mediaKind(m)) !== 'audio') return false;
  // Nunca duplicar tentativa pendente/incerta, nem satisfazer a mesma inbound duas vezes.
  return used.every(p => ['sent','delivered','read'].includes(p.status) && p.phase !== 'uncertain' && p.request_id !== inbound);
}

/** Exceção de cópia repetida só para reenvio solicitado e comprovado pelo servidor.
 * O título da mídia é metadado fixo, não um texto que o modelo possa variar.
 * Não libera primeira entrega, campanha, outro contato ou tentativa incerta.
 * Aprovação/etapa são conferidas pelo catálogo fresco e novamente no transporte. */
export async function isRequestedApprovedMediaReplay(
  db: Queryable, org: string, conversation: string, contact: string, agent: string, job: string, media: ApprovedAudio,
): Promise<boolean> {
  if (!media.enabled || !media.allow_requested_repeat) return false;
  const { rows } = await db.query<{ inbound: string | null }>(
    `select payload->>'inbound_message_id' as inbound from job_queue
     where organization_id=$1 and id=$2 and contact_id=$3 and kind='inbound_turn' and status='running'
       and payload->>'conversation_id'=$4
       and payload->'audio_rule_decision'->>'agent_id'=$5
       and payload->'audio_rule_decision'->>'audio_id'=$6`,
    [org,job,contact,conversation,agent,media.id]);
  const inbound = rows[0]?.inbound;
  if (!inbound) return false;
  const prior = (await history(db,org,conversation)).filter(p => p.job_id !== job);
  const used = prior.filter(p => p.agent_id === agent && p.audio_id === media.id
    || !!media.content_sha256 && p.fingerprint === media.content_sha256);
  if (!used.length) return false;
  const decision = await loadTurnMediaDecision(db,org,conversation,agent,job);
  const text = await requestText(db,org,conversation,inbound,job,!!decision);
  return permitted(media,prior,agent,inbound,text,decision)
    && (decision?.authorized_id === media.id || withTurnMediaPreference(await conversationAllowsMedia(db,org,conversation,mediaKind(media)),text,mediaKind(media)));
}

export async function availableConversationAudios(
  db: Queryable, org: string, conversation: string, agent: string, job: string,
  audios: ApprovedAudio[], inbound: string | null, firstContact?: boolean, provisional?: MediaDecision,
  onDecision?: (reason: string) => void,
): Promise<ApprovedAudio[]> {
  if (!audios.length) return audios;
  const prior = (await history(db,org,conversation)).filter(p => p.job_id !== job);
  const decision = provisional ?? await loadTurnMediaDecision(db,org,conversation,agent,job);
  const text = await requestText(db,org,conversation,inbound,job,!!decision);
  const allowed = new Map<string,boolean>();
  for (const kind of new Set(audios.map(mediaKind))) allowed.set(kind,
    withTurnMediaPreference(await conversationAllowsMedia(db,org,conversation,kind),text,kind));
  let candidates = audios;
  if (decision) {
    const item = candidates.find(m => m.id === decision.audio_id);
    if (!item || mediaApprovalHash(item) !== decision.approval_sha256
      || !provisional && decision.authorized_id !== item.id) return [];
    const result = authorizeMediaIntent({ item, intent: decision, policy: decision.policy,
      legacyRequest: explicitMediaPreference(text,mediaKind(item)) === 'audio',
      allowsFormat: explicitMediaPreference(text,mediaKind(item)) !== 'text'
        && (decision.format === mediaKind(item) || decision.intent === 'repeat' || allowed.get(mediaKind(item)) === true),
      inbound, used: prior.filter(p => p.agent_id === agent || !!item.content_sha256 && p.fingerprint === item.content_sha256)
        .map(p => ({ id: p.audio_id, fingerprint: p.fingerprint, confirmed: ['sent','delivered','read'].includes(p.status) && p.phase !== 'uncertain', request: p.request_id })),
    });
    onDecision?.(result.reason);
    if (firstContact === false && item.trigger_type === 'first_contact' && decision.intent !== 'repeat') return [];
    return result.allowed ? [item] : [];
  }
  if (refersToPreviousMedia(text)) {
    const kinds = (['audio','image','video'] as const).filter(k => explicitMediaPreference(text,k) === 'audio');
    const last = prior.find(p => kinds.includes(p.kind as 'audio' | 'image' | 'video'));
    // “Aquele áudio” aponta à última gravação desse formato, não a outro arquivo novo.
    if (kinds.length) candidates = last ? audios.filter(m => m.id === last.audio_id && agent === last.agent_id
      || !!m.content_sha256 && m.content_sha256 === last.fingerprint) : [];
  }
  return candidates.filter(m => allowed.get(mediaKind(m))
    && (firstContact !== false || m.trigger_type !== 'first_contact' || !!m.allow_requested_repeat
      && explicitMediaPreference(text,mediaKind(m)) === 'audio')
    && permitted(m,prior,agent,inbound,text));
}

export async function assertConversationAudioAvailable(
  db: Queryable, org: string, conversation: string, agent: string, audio: string, ownMessage: string, job?: string, approved?: ApprovedAudio,
): Promise<void> {
  const prior = (await history(db,org,conversation)).filter(p => p.id !== ownMessage);
  let inbound: string | null = null;
  if (job) {
    const { rows: jobs } = await db.query<{ inbound: string | null }>(
      `select payload->>'inbound_message_id' as inbound from job_queue where organization_id=$1 and id=$2
       and kind='inbound_turn' and payload->>'conversation_id'=$3`,[org,job,conversation]);
    inbound = jobs[0]?.inbound ?? null;
  }
  // Contrato legado: aprovação é verificada pelo chamador; sem catálogo não há exceção de reenvio.
  if (!approved) {
    if (!withTurnMediaPreference(await conversationAllowsAudio(db,org,conversation),await requestText(db,org,conversation,inbound,job),'audio'))
      throw new OutboundAudioUnavailableError('audio_text_preference');
    if (prior.some(p => p.agent_id === agent && p.audio_id === audio)) throw new OutboundAudioUnavailableError('audio_already_used');
    return;
  }
  const m = approved;
  if (m.id !== audio || !m.enabled) throw new OutboundAudioUnavailableError('audio_approval_revoked');
  // Mensagens antigas podem não ter request_inbound_id. Outro ledger do
  // MESMO job ainda não é um novo pedido e não autoriza uma segunda cópia.
  if (job && prior.some(p => p.job_id === job && (p.agent_id === agent && p.audio_id === m.id
    || !!m.content_sha256 && p.fingerprint === m.content_sha256)))
    throw new OutboundAudioUnavailableError('audio_already_used');
  const decision = job ? await loadTurnMediaDecision(db,org,conversation,agent,job) : null;
  if (decision) {
    const { rows } = await db.query<{ config: unknown }>(
      'select config from ai_agents where id=$1 and organization_id=$2 and archived_at is null',[agent,org]);
    if (!rows[0] || readMediaReplayPolicy(rows[0].config) !== decision.policy || mediaApprovalHash(m) !== decision.approval_sha256)
      throw new OutboundAudioUnavailableError('audio_approval_revoked');
  }
  const currentText = await requestText(db,org,conversation,inbound,job,!!decision);
  const allows = withTurnMediaPreference(await conversationAllowsMedia(db,org,conversation,mediaKind(m)),currentText,mediaKind(m));
  if (decision ? decision.text_only || decision.authorized_id !== m.id || explicitMediaPreference(currentText,mediaKind(m)) === 'text'
      || (decision.format !== mediaKind(m) && decision.intent !== 'repeat' && !allows)
    : !allows)
    throw new OutboundAudioUnavailableError('audio_text_preference');
  if (!permitted(m,prior,agent,inbound,currentText,decision))
    throw new OutboundAudioUnavailableError('audio_already_used');
}
