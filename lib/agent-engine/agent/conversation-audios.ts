import type { Queryable } from '../queue/queue';
import type { ApprovedAudio } from '@/lib/ai/agents/approved-audios';
import { OutboundAudioUnavailableError } from '@/lib/channels/delivery-error';

// Inclui pendência e incerteza: falta de confirmação não autoriza outra cópia.
const HELD = `(m.external_id is not null or m.status in ('sent','delivered','read','sending')
  or m.metadata->'outbound_attempt'->>'phase' in ('started','uncertain','confirmed')
  or (m.status in ('queued','failed') and m.metadata->'outbound_attempt'->>'phase'='prepared'
      and coalesce(m.metadata->'outbound_attempt'->>'retryable','true')<>'false'))`;

export function explicitAudioPreference(text: string): 'text' | 'audio' | null {
  const s = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\b(?:nao|no|don't|do not)\s+(?:me\s+)?(?:quero|quiero|gosto de|pode|mande|mandes|mandar|envie|enviar|use|send|want)[^.!?\n]{0,35}(?:audio|voice)/.test(s)
    || /\b(?:prefiro|prefiero|prefer|somente|apenas|so|solo|only)\b[^.!?\n]{0,25}(?:texto|text|escrito|written)/.test(s)
    || /\b(?:sem|sin|no)\s+(?:audio|voice)/.test(s)) return 'text';
  if (/\b(?:pode|puede|puedes|quero|quiero|please|you can)\s+(?:me\s+)?(?:mandar|enviar|ouvir|escuchar|send)[^.!?\n]{0,25}(?:audio|voice)/.test(s)) return 'audio';
  return null;
}

/** Preferência durável na própria inbound; não some quando a janela do LLM gira. */
export async function conversationAllowsAudio(db: Queryable, org: string, conversation: string): Promise<boolean> {
  const { rows } = await db.query<{ preference: string }>(
    `select metadata->>'agent_audio_preference' as preference from messages
      where organization_id=$1 and conversation_id=$2 and direction='inbound'
        and metadata->>'agent_audio_preference' in ('text','audio')
      order by created_at desc,id desc limit 1`, [org, conversation],
  );
  return rows[0]?.preference !== 'text';
}

export async function availableConversationAudios(
  db: Queryable, org: string, conversation: string, agent: string, job: string,
  audios: ApprovedAudio[], inboundId: string | null,
): Promise<ApprovedAudio[]> {
  if (!audios.length) return audios;
  const { rows: inbound } = await db.query<{ id: string; body: string | null }>(
    `select id,body from messages where organization_id=$1 and conversation_id=$2
      and direction='inbound' and ($3::uuid is null or id=$3)
      order by created_at desc,id desc limit 1`, [org, conversation, inboundId],
  );
  const preference = explicitAudioPreference(inbound[0]?.body ?? '');
  if (preference) await db.query(
    `update messages set metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('agent_audio_preference',$4::text)
      where organization_id=$1 and conversation_id=$2 and id=$3 and direction='inbound'`,
    [org, conversation, inbound[0]!.id, preference],
  );
  if (!(await conversationAllowsAudio(db, org, conversation))) return [];
  const { rows } = await db.query<{ audio_id: string; job_id: string | null }>(
    `select m.metadata->'approved_audio'->>'audio_id' as audio_id,l.job_id
       from messages m left join send_ledger l on l.organization_id=m.organization_id
         and l.id::text=m.metadata->>'idempotency_key'
      where m.organization_id=$1 and m.conversation_id=$2 and m.direction='outbound'
        and m.metadata->'approved_audio'->>'agent_id'=$3 and ${HELD}`, [org, conversation, agent],
  );
  // O mesmo job conserva o plano/seq para replay; a guarda fresca exclui só a
  // própria mensagem. Outro turno nunca ganha licença para reenviar a gravação.
  const used = new Set(rows.filter(r => r.job_id !== job).map(r => r.audio_id));
  return audios.filter(a => !used.has(a.id));
}

export async function assertConversationAudioAvailable(
  db: Queryable, org: string, conversation: string, agent: string, audio: string, ownMessage: string,
): Promise<void> {
  if (!(await conversationAllowsAudio(db, org, conversation))) throw new OutboundAudioUnavailableError('audio_text_preference');
  const { rows } = await db.query(
    `select m.id from messages m where m.organization_id=$1 and m.conversation_id=$2
      and m.direction='outbound' and m.metadata->'approved_audio'->>'agent_id'=$3
      and m.metadata->'approved_audio'->>'audio_id'=$4 and m.id<>$5 and ${HELD} limit 1`,
    [org, conversation, agent, audio, ownMessage],
  );
  if (rows.length) throw new OutboundAudioUnavailableError('audio_already_used');
}
