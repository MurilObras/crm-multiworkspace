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
  // Negação não atravessa outra oração nem troca o objeto ("não quero texto,
  // manda áudio"). Preferência exige o meio logo depois, não qualquer menção.
  const negativeAudio = [...s.matchAll(/\b(?:nao|no|don't|do not)\s+(?:me\s+)?(?:quero|quiero|gosto de|pode|manda|mande|mandes|mandar|envia|envie|enviar|use|send|want)[^.!?,;\n]{0,35}(?:audio|voice)/g)]
    .some(match => !/\b(?:texto|text|escrito|written)\b/.test(match[0]));
  const affirmative = s.replace(/\b(?:nao|no|don't|do not)\s+(?:quero|quiero|prefiro|prefiero|prefer)\b[^.!?,;\n]*/g, '');
  if (negativeAudio
    || /\b(?:prefiro|prefiero|prefer|quero|quiero|somente|apenas|so|solo|only)\s+(?:(?:receber|receive|to|communicate|in|por|em|via|somente|apenas|so|solo|only|mensagens|mensagem|messages|de|o|el|the)\s+){0,4}(?:texto|text|escrito|written)\b/.test(affirmative)
    || /\b(?:sem|sin|nao|no)\s+(?:audio|voice)/.test(s)) return 'text';
  if (/\b(?:pode|puede|puedes|quero|quiero|please|you can)\s+(?:me\s+)?(?:mandar|enviar|ouvir|escuchar|send)[^.!?,;\n]{0,25}(?:audio|voice)/.test(s)
    || /\b(?:prefiro|prefiero|prefer|quero|quiero|somente|apenas|so|solo|only)\s+(?:(?:receber|receive|to|ouvir|hear|escuchar|o|el|the)\s+){0,3}(?:audios?|voice)\b/.test(affirmative)
    || /(?:^|[.!?,;\n]\s*)(?:manda|mande|envia|envie|send)\s+(?:me\s+)?(?:um\s+|un\s+|a\s+)?(?:audios?|voice)\b/.test(s)) return 'audio';
  return null;
}

/** Preferência durável na própria inbound; não some quando a janela do LLM gira. */
export async function conversationAllowsAudio(db: Queryable, org: string, conversation: string): Promise<boolean> {
  // O debounce pode absorver a mensagem que contém a preferência. Reconciliar
  // todas as inbounds ainda não examinadas, inclusive no último pré-voo, evita
  // depender de um turno separado para aquela mensagem. Lotes limitam memória.
  // O marcador inclui a fonte examinada: uma transcrição tardia ou corrigida
  // precisa passar pela mesma reconciliação. O CAS cobre corpo E derivado.
  for (;;) {
    const { rows: pending } = await db.query<{ id: string; body: string | null; media_derived_text: string | null; source: string }>(
      `select id,body,media_derived_text,md5(jsonb_build_array(body,media_derived_text)::text) as source
        from messages where organization_id=$1 and conversation_id=$2 and direction='inbound'
        and (metadata->>'agent_audio_preference_checked' is distinct from 'true'
          or metadata->>'agent_audio_preference_source' is distinct from md5(jsonb_build_array(body,media_derived_text)::text))
        order by coalesce(sent_at,created_at),created_at,id limit 100`, [org, conversation],
    );
    if (!pending.length) break;
    await db.query(
      `update messages m set metadata=(case when m.metadata ? 'agent_audio_preference_source'
          then m.metadata - 'agent_audio_preference' else coalesce(m.metadata,'{}'::jsonb) end)
        || jsonb_build_object('agent_audio_preference_checked',true,'agent_audio_preference_source',p.source)
        || case when p.preference in ('text','audio') then jsonb_build_object('agent_audio_preference',p.preference) else '{}'::jsonb end
        from jsonb_to_recordset($3::jsonb) as p(id uuid,source text,preference text)
        where m.organization_id=$1 and m.conversation_id=$2 and m.id=p.id and m.direction='inbound'
          and md5(jsonb_build_array(m.body,m.media_derived_text)::text)=p.source
          and (m.metadata->>'agent_audio_preference_checked' is distinct from 'true'
            or m.metadata->>'agent_audio_preference_source' is distinct from p.source)`,
      [org, conversation, JSON.stringify(pending.map(m => ({ id: m.id, source: m.source,
        preference: explicitAudioPreference([m.body, m.media_derived_text].filter(Boolean).join('\n')) })))],
    );
  }
  const { rows } = await db.query<{ preference: string }>(
    `select metadata->>'agent_audio_preference' as preference from messages
      where organization_id=$1 and conversation_id=$2 and direction='inbound'
        and metadata->>'agent_audio_preference' in ('text','audio')
      order by coalesce(sent_at,created_at) desc,created_at desc,id desc limit 1`, [org, conversation],
  );
  return rows[0]?.preference !== 'text';
}

export async function availableConversationAudios(
  db: Queryable, org: string, conversation: string, agent: string, job: string,
  audios: ApprovedAudio[], _inboundId: string | null,
): Promise<ApprovedAudio[]> {
  if (!audios.length) return audios;
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
