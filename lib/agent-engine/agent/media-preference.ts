import type { Queryable } from '../queue/queue';
import { conversationAllowsAudio, explicitAudioPreference } from './audio-preference';

export function explicitMediaPreference(text: string, kind: 'audio' | 'image' | 'video'): 'text' | 'audio' | null {
  if (kind === 'audio') return explicitAudioPreference(text);
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const pattern = kind === 'image' ? /\b(?:fotos?|imagem|imagens|imagen(?:es)?)\b/g : /\bvideos?\b/g;
  // Reaproveita a gramática de preferência sem confundir pedido de outro formato.
  return explicitAudioPreference(normalized.replace(/\baudios?\b/g, 'outroformato').replace(pattern, 'audio'));
}

export function refersToPreviousMedia(text: string): boolean {
  const s = text.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/^[\p{L}]+\s*,\s*/u,'');
  if (!/\b(?:de novo|novamente|reenvi\w*|repete|repita|repetir|aquele|aquela|esse|essa)\b/.test(s)) return false;
  // Assunto nomeado (“o vídeo de preços novamente”) é resolvido pelas regras,
  // não substituído pela última mídia apenas por ser mais recente.
  return s.replace(/\b(?:de novo|por favor|voce|pode|poderia|me|pra|para|mim|manda|mande|enviar|envia|envie|reenviar|reenvia|reenvie|repete|repita|repetir|quero|ouvir|ver|aquele|aquela|esse|essa|o|a|um|uma|audio|video|foto|imagem|novamente|agora)\b/g,'')
    .replace(/[\s.!?,;:]+/g,'') === '';
}

/** Preferências visuais também são duráveis, mesmo depois de a janela do modelo girar. */
export async function conversationAllowsVisual(db: Queryable, org: string, conversation: string, kind: 'image' | 'video'): Promise<boolean> {
  for (;;) {
    const { rows } = await db.query<{ id: string; body: string | null; media_derived_text: string | null; source: string }>(
      `select id,body,media_derived_text,md5(jsonb_build_array(body,media_derived_text)::text) as source
       from messages where organization_id=$1 and conversation_id=$2 and direction='inbound'
        and metadata->>'agent_visual_preference_source' is distinct from md5(jsonb_build_array(body,media_derived_text)::text)
       order by coalesce(sent_at,created_at),created_at,id limit 100`, [org, conversation]);
    if (!rows.length) break;
    await db.query(`update messages m set metadata=coalesce(m.metadata,'{}'::jsonb)
        - 'agent_image_preference' - 'agent_video_preference'
        || jsonb_strip_nulls(jsonb_build_object('agent_visual_preference_source',p.source,
           'agent_image_preference',p.image,'agent_video_preference',p.video))
       from jsonb_to_recordset($3::jsonb) as p(id uuid,source text,image text,video text)
       where m.organization_id=$1 and m.conversation_id=$2 and m.id=p.id and m.direction='inbound'
        and md5(jsonb_build_array(m.body,m.media_derived_text)::text)=p.source
        and m.metadata->>'agent_visual_preference_source' is distinct from p.source`,
    [org, conversation, JSON.stringify(rows.map(m => {
      const text = [m.body,m.media_derived_text].filter(Boolean).join('\n');
      return { id: m.id, source: m.source, image: explicitMediaPreference(text,'image'), video: explicitMediaPreference(text,'video') };
    }))]);
  }
  const key = kind === 'image' ? 'agent_image_preference' : 'agent_video_preference';
  const { rows } = await db.query<{ preference: string }>(`select metadata->>$3 as preference from messages
    where organization_id=$1 and conversation_id=$2 and direction='inbound' and metadata->>$3 in ('text','audio')
    order by coalesce(sent_at,created_at) desc,created_at desc,id desc limit 1`, [org,conversation,key]);
  return rows[0]?.preference !== 'text';
}

export const conversationAllowsMedia = (db: Queryable, org: string, conversation: string, kind: 'audio' | 'image' | 'video') =>
  kind === 'audio' ? conversationAllowsAudio(db,org,conversation) : conversationAllowsVisual(db,org,conversation,kind);
