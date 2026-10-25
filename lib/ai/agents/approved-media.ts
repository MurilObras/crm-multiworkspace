import { z } from 'zod';
import { audioDescriptionSchema, approvedAudioSchema, audioPathOwnedBy, AUDIO_MAX_BYTES, AUDIO_MAX_FILES } from './approved-audios';

export const MEDIA_MAX_BYTES = AUDIO_MAX_BYTES;
export const MEDIA_MAX_FILES = AUDIO_MAX_FILES;
export const MEDIA_ACCEPT = '.mp3,.m4a,.aac,.ogg,.opus,.wav,.webm,.jpg,.jpeg,.png,.mp4';
export const visualMediaSchema = audioDescriptionSchema.extend({
  id: z.string().uuid(), type: z.enum(['image', 'video']), storage_path: z.string().min(1),
  mime: z.enum(['image/jpeg', 'image/png', 'video/mp4']),
  size_bytes: z.number().int().positive().max(MEDIA_MAX_BYTES), enabled: z.boolean(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  storage_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(m => m.type === 'video' ? m.mime === 'video/mp4' : m.mime.startsWith('image/'));
export const approvedMediaSchema = z.union([approvedAudioSchema, visualMediaSchema]);
export type ApprovedMedia = z.infer<typeof approvedMediaSchema>;
export type MediaPreview = ApprovedMedia & { preview_url: string | null };
export const mediaKind = (m: ApprovedMedia): 'audio' | 'image' | 'video' => 'type' in m ? m.type : 'audio';

/** O leitor antigo usa Zod strict: campos novos não podem vazar para a projeção. */
export function legacyAudioProjection(media: ApprovedMedia[]) {
  return media.filter(m => !('type' in m)).map(m => {
    const legacy = { ...m };
    delete legacy.allow_requested_repeat;
    delete legacy.content_sha256;
    delete legacy.storage_sha256;
    return legacy;
  });
}

/** approved_media é canônico; approved_audios permanece uma projeção para leitores antigos. */
export function readApprovedMedia(config: unknown): ApprovedMedia[] {
  if (!config || typeof config !== 'object') return [];
  const c = config as Record<string, unknown>;
  const parsed = z.array(approvedMediaSchema).max(MEDIA_MAX_FILES).safeParse(c.approved_media ?? c.approved_audios ?? []);
  return parsed.success ? parsed.data : [];
}

export function mediaPathOwnedBy(m: ApprovedMedia, org: string, agent: string): boolean {
  if (!('type' in m)) return audioPathOwnedBy(m, org, agent);
  const ext = m.mime === 'image/jpeg' ? 'jpg' : m.mime === 'image/png' ? 'png' : 'mp4';
  return m.storage_path === `${org}/agent-media/${agent}/${m.id}.${ext}`;
}

export function renderApprovedMedia(media: ApprovedMedia[]): string {
  const optional = media.filter(m => m.enabled && !m.required);
  if (!optional.length) return '';
  return 'MÍDIAS APROVADAS DISPONÍVEIS\n' + JSON.stringify(optional.map(m => ({
    id: m.id, tipo: mediaKind(m), titulo: m.title, conteudo: m.use_when, quando_usar: m.send_when || m.use_when,
  }))) + '\nUse a mídia correspondente ao assunto atual, sem esperar pedido de mídia na primeira utilização. '
    + 'Não envie só pela etapa. Respeite só texto, humano e recusas. Primeiro envie contexto curto em texto, sem anunciar gravação ou envio futuro; '
    + 'depois send_message com media={type:"audio",audio_id:"ID"} para áudio ou media={type:"image|video",media_id:"ID"} para foto/vídeo. '
    + 'O catálogo já considera o histórico: sem pedido explícito e permissão configurada, uma mídia utilizada não fica disponível. '
    + 'Não duplique a explicação gravada nem confirme entrega antes do resultado real. Após o resultado da mídia, encerre a resposta sem outra explicação. '
    + 'Se houver uma pergunta comercial realmente útil, inclua-a no contexto breve anterior ao arquivo. Se houver veto, não ofereça URL para contornar nem prometa consultar material que já consta no catálogo.';
}
