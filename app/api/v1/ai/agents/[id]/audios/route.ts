import { randomUUID } from 'node:crypto';
import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { requireRole } from '@/lib/auth/require-role';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { AUDIO_MAX_BYTES, AUDIO_MAX_FILES, audioDescriptionSchema, audioStageIdsSchema, audioPathOwnedBy,
  readApprovedAudios, type ApprovedAudio } from '@/lib/ai/agents/approved-audios';
import { normalizePrerecordedAudio, prerecordedAudioFormat } from '@/lib/messaging/media/prerecorded-audio';
import { loadAudioStageOptions } from '@/lib/ai/agents/audio-stage-options';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const editSchema = audioDescriptionSchema.partial().extend({ audio_id: z.string().uuid(), enabled: z.boolean().optional(),
  stage_ids: audioStageIdsSchema.optional(), required: z.boolean().optional() })
  .strict().refine(v => v.enabled !== undefined || v.title !== undefined || v.use_when !== undefined || v.stage_ids !== undefined || v.required !== undefined);
const removeSchema = z.object({ audio_id: z.string().uuid() }).strict();

async function handle(req: NextRequest, ctx: Context, mode: 'read' | 'add' | 'edit' | 'remove'): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole(mode === 'read' ? 'manager' : 'admin', { requestId, resource: 'ai_agent_audios' });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail('invalid_request', 'Agente inválido.', 400, { requestId });
  const org = auth.org.orgId;
  const admin = createAdminClient();
  const { data: agent, error } = await admin.from('ai_agents').select('id,config')
    .eq('organization_id', org).eq('id', id).eq('kind', 'mcp_agent').is('archived_at', null).maybeSingle();
  if (error) return fail('internal_error', 'Erro ao carregar áudios.', 500, { requestId });
  if (!agent) return fail('not_found', 'Agente não encontrado neste workspace.', 404, { requestId });
  const current = readApprovedAudios(agent.config);
  const audios = current.filter(a => audioPathOwnedBy(a, org, id));
  let stages;
  try { stages = await loadAudioStageOptions(admin, org); }
  catch { return fail('internal_error', 'Não foi possível carregar as etapas dos funis. Atualize a lista e tente novamente.', 500, { requestId }); }
  if (mode === 'read') {
    const previews = await Promise.all(audios.map(async a => {
      const { data } = await admin.storage.from('whatsapp-media').createSignedUrl(a.storage_path, 1800);
      return { ...a, preview_url: data?.signedUrl ?? null };
    }));
    return ok(previews, { requestId, meta: { stage_options: stages }, headers: { 'Cache-Control': 'private, no-store' } });
  }
  let next: ApprovedAudio[];
  let uploaded: string | null = null;
  let audioId: string;
  if (mode === 'add') {
    if (audios.length >= AUDIO_MAX_FILES) return fail('validation_failed', 'Limite de 20 áudios por agente. Remova uma gravação para adicionar outra.', 422, { requestId });
    if (Number(req.headers.get('content-length') ?? 0) > AUDIO_MAX_BYTES + 1_048_576) {
      return fail('payload_too_large', 'Áudio acima de 16 MB.', 413, { requestId });
    }
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    let stageIds: unknown = [];
    try { if (form?.has('stage_ids')) stageIds = JSON.parse(String(form.get('stage_ids'))); }
    catch { return fail('validation_failed', 'Vínculo de etapas inválido.', 422, { requestId }); }
    const required = form?.get('required') ?? 'true';
    if (required !== 'true' && required !== 'false') return fail('validation_failed', 'Modo de envio inválido.', 422, { requestId });
    const description = audioDescriptionSchema.safeParse({ title: form?.get('title'), use_when: form?.get('use_when'),
      stage_ids: stageIds, required: required === 'true' });
    if (!(file instanceof File) || !description.success || !file.size) {
      return fail('validation_failed', 'Informe arquivo, título e quando o agente deve usar a gravação.', 422, { requestId });
    }
    if (description.data.stage_ids.some(stage => !stages.some(s => s.id === stage))) {
      return fail('validation_failed', 'Escolha somente etapas ativas dos funis deste workspace.', 422, { requestId });
    }
    if (file.size > AUDIO_MAX_BYTES) return fail('payload_too_large', 'Áudio acima de 16 MB.', 413, { requestId });
    if (!prerecordedAudioFormat(file.type)) return fail('unsupported_media_type', 'Use MP3, M4A, AAC, OGG, WAV ou WebM de áudio.', 415, { requestId });
    let bytes: Buffer;
    try {
      bytes = await normalizePrerecordedAudio(Buffer.from(await file.arrayBuffer()), file.type);
    } catch {
      logger.warn('agent_audio_conversion_failed', { requestId });
      return fail('validation_failed', 'Não foi possível preparar o áudio. Verifique o arquivo e tente novamente. Se persistir, confira o ffmpeg do servidor.', 422, { requestId });
    }
    audioId = randomUUID();
    uploaded = `${org}/agent-audios/${id}/${audioId}.ogg`;
    const { error: uploadError } = await admin.storage.from('whatsapp-media')
      .upload(uploaded, bytes, { contentType: 'audio/ogg', upsert: false });
    if (uploadError) return fail('internal_error', 'Erro ao guardar áudio. Tente novamente.', 500, { requestId });
    next = [...audios, { ...description.data, id: audioId, storage_path: uploaded,
      mime: 'audio/ogg', size_bytes: bytes.length, enabled: true }];
  } else {
    const raw = await req.json().catch(() => null);
    const parsed = mode === 'edit' ? editSchema.safeParse(raw) : removeSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Alteração de áudio inválida.', 422, { requestId });
    audioId = parsed.data.audio_id;
    if (!audios.some(a => a.id === audioId)) return fail('not_found', 'Áudio não encontrado.', 404, { requestId });
    const edit = mode === 'edit' ? editSchema.parse(raw) : null;
    if (edit?.stage_ids?.some(stage => !stages.some(s => s.id === stage))) {
      return fail('validation_failed', 'Escolha somente etapas ativas dos funis deste workspace.', 422, { requestId });
    }
    next = mode === 'remove' ? audios.filter(a => a.id !== audioId)
      : audios.map(a => a.id === audioId ? { ...a,
        ...(edit?.enabled !== undefined ? { enabled: edit.enabled } : {}),
        ...(edit?.title !== undefined ? { title: edit.title } : {}),
        ...(edit?.use_when !== undefined ? { use_when: edit.use_when } : {}),
        ...(edit?.required !== undefined ? { required: edit.required } : {}),
        ...(edit?.stage_ids !== undefined ? { stage_ids: edit.stage_ids } : {}) } : a);
  }
  // CAS sobre o JSON lido: duas abas nunca sobrescrevem silenciosamente o catálogo.
  let update = admin.from('ai_agents').update({ config: { ...(agent.config as Record<string, unknown> ?? {}), approved_audios: next } })
    .eq('id', id).eq('organization_id', org).is('archived_at', null);
  update = agent.config == null ? update.is('config', null) : update.filter('config', 'eq', JSON.stringify(agent.config));
  const { data: saved, error: saveError } = await update.select('id').maybeSingle();
  if (saveError || !saved) {
    if (uploaded) await admin.storage.from('whatsapp-media').remove([uploaded]);
    return fail(saveError ? 'internal_error' : 'state_conflict',
      saveError ? 'Erro ao salvar áudio.' : 'O agente foi alterado em outra aba. Atualize a lista e tente novamente.',
      saveError ? 500 : 409, { requestId });
  }
  void audit({ action: 'ai_agent.updated', actorUserId: auth.user.id, organizationId: org,
    resourceType: 'ai_agent', resourceId: id, requestId, metadata: { audio_action: mode, audio_id: audioId } });
  return ok({ saved: true }, { requestId });
}

export const GET = (req: NextRequest, ctx: Context) => handle(req, ctx, 'read');
export const POST = (req: NextRequest, ctx: Context) => handle(req, ctx, 'add');
export const PATCH = (req: NextRequest, ctx: Context) => handle(req, ctx, 'edit');
export const DELETE = (req: NextRequest, ctx: Context) => handle(req, ctx, 'remove');
