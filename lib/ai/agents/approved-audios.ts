import { z } from 'zod';

export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
export const AUDIO_MAX_FILES = 20;
export const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.ogg,.opus,.wav,.webm';
export const audioStageIdsSchema = z.array(z.string().uuid()).max(100);
export const audioDescriptionSchema = z.object({
  title: z.string().trim().min(2).max(120),
  use_when: z.string().trim().min(10).max(1000),
  stage_ids: audioStageIdsSchema.default([]),
  // Catálogos antigos não passam a disparar automaticamente após atualizar.
  required: z.boolean().default(false),
}).strict();
export const approvedAudioSchema = audioDescriptionSchema.extend({
  id: z.string().uuid(),
  storage_path: z.string().min(1),
  mime: z.literal('audio/ogg'),
  size_bytes: z.number().int().positive().max(AUDIO_MAX_BYTES),
  enabled: z.boolean(),
}).strict();
export type ApprovedAudio = z.infer<typeof approvedAudioSchema>;
export type AudioPreview = ApprovedAudio & { preview_url: string | null };
export interface AudioStageOption { id: string; name: string; pipeline_id: string; pipeline_name: string }

/** JSON operacional da organização; um catálogo inválido nunca libera arquivos. */
export function readApprovedAudios(config: unknown): ApprovedAudio[] {
  if (!config || typeof config !== 'object') return [];
  const parsed = z.array(approvedAudioSchema).max(AUDIO_MAX_FILES)
    .safeParse((config as Record<string, unknown>).approved_audios ?? []);
  return parsed.success ? parsed.data : [];
}

export function audioPathOwnedBy(audio: ApprovedAudio, org: string, agent: string): boolean {
  return audio.storage_path === `${org}/agent-audios/${agent}/${audio.id}.ogg`;
}

export function renderApprovedAudios(audios: ApprovedAudio[]): string {
  const active = audios.filter(a => a.enabled && !a.required);
  if (!active.length) return '';
  return `ÁUDIOS PRÉ-GRAVADOS APROVADOS\n${JSON.stringify(active.map(a => ({ id: a.id, titulo: a.title, quando_usar: a.use_when })))}\n`
    + 'Você pode escolher uma destas gravações quando for útil ao atendimento. Não invente o conteúdo. '
    + 'Respeite pedidos de resposta em texto. Cada gravação é enviada no máximo uma vez por conversa. '
    + 'Envie primeiro uma mensagem curta de contexto com send_message SEM media. Depois envie '
    + 'send_message com media={type:"audio",audio_id:"ID aprovado"}; body é somente o título para o histórico, '
    + 'não é legenda nem texto entregue junto do áudio. Cada chamada consome uma mensagem do limite do turno. '
    + 'Se não houver espaço para as duas mensagens, responda em texto. Não diga que enviou antes da confirmação.';
}
