import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { requireRole } from '@/lib/auth/require-role';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { AUDIO_MAX_BYTES, AUDIO_MAX_FILES, audioDescriptionSchema, audioStageIdsSchema, audioTriggerSchema } from '@/lib/ai/agents/approved-audios';
import { readApprovedMedia, mediaPathOwnedBy, mediaKind, legacyAudioProjection, type ApprovedMedia } from '@/lib/ai/agents/approved-media';
import { validateApprovedVisual } from '@/lib/messaging/media/approved-visual';
import { normalizePrerecordedAudio, prerecordedAudioFormat } from '@/lib/messaging/media/prerecorded-audio';
import { loadAudioStageOptions } from '@/lib/ai/agents/audio-stage-options';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const editSchema = audioDescriptionSchema.partial().extend({ audio_id: z.string().uuid(), enabled: z.boolean().optional(),
  stage_ids: audioStageIdsSchema.optional(), required: z.boolean().optional(),
  trigger_type: audioTriggerSchema.optional(), send_when: z.string().trim().max(1000).optional() })
  .strict().refine(v => v.enabled !== undefined || v.title !== undefined || v.use_when !== undefined || v.stage_ids !== undefined || v.required !== undefined || v.trigger_type !== undefined || v.send_when !== undefined || v.allow_requested_repeat !== undefined);
const removeSchema = z.object({ audio_id: z.string().uuid() }).strict();

async function handle(req: NextRequest, ctx: Context, mode: 'read' | 'add' | 'edit' | 'remove'): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole(mode === 'read' ? 'manager' : 'admin', { requestId, resource: 'ai_agent_audios' });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail('invalid_request', 'Agente inválido.', 400, { requestId });
  const org = auth.org.orgId;
  const admin = createAdminClient();
  const { data: agent, error } = await admin.from('ai_agents').select('id,config,config_revision')
    .eq('organization_id', org).eq('id', id).eq('kind', 'mcp_agent').is('archived_at', null).maybeSingle();
  if (error) return fail('internal_error', 'Erro ao carregar mídias.', 500, { requestId });
  if (!agent) return fail('not_found', 'Agente não encontrado neste workspace.', 404, { requestId });
  const unified = req.nextUrl.pathname.endsWith('/media');
  const current = readApprovedMedia(agent.config);
  const rawCatalog = (agent.config as Record<string, unknown> | null)?.approved_media
    ?? (agent.config as Record<string, unknown> | null)?.approved_audios;
  if (rawCatalog != null && (!Array.isArray(rawCatalog) || rawCatalog.length > 0 && current.length === 0))
    return fail('state_conflict', 'O catálogo de mídias está inválido. Nenhum arquivo foi sobrescrito.', 409, { requestId });
  const audios = current.filter(a => mediaPathOwnedBy(a, org, id));
  if (audios.length !== current.length)
    return fail('state_conflict', 'Há arquivos sem vínculo válido com este agente. Nenhum arquivo foi sobrescrito.', 409, { requestId });
  let stages;
  try { stages = await loadAudioStageOptions(admin, org); }
  catch { return fail('internal_error', 'Não foi possível carregar as etapas dos funis. Atualize a lista e tente novamente.', 500, { requestId }); }
  if (mode === 'read') {
    const previews = await Promise.all(audios.filter(a => unified || mediaKind(a) === 'audio').map(async a => {
      const { data } = await admin.storage.from('whatsapp-media').createSignedUrl(a.storage_path, 1800);
      return { ...a, preview_url: data?.signedUrl ?? null };
    }));
    return ok(previews, { requestId, meta: { stage_options: stages }, headers: { 'Cache-Control': 'private, no-store' } });
  }
  let next: ApprovedMedia[];
  let uploaded: string | null = null;
  let audioId: string;
  if (mode === 'add') {
    if (audios.length >= AUDIO_MAX_FILES) return fail('validation_failed', 'Limite de 20 mídias por agente. Remova um arquivo para adicionar outro.', 422, { requestId });
    if (Number(req.headers.get('content-length') ?? 0) > AUDIO_MAX_BYTES + 1_048_576) {
      return fail('payload_too_large', 'Arquivo acima de 16 MB.', 413, { requestId });
    }
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    let stageIds: unknown = [];
    try { if (form?.has('stage_ids')) stageIds = JSON.parse(String(form.get('stage_ids'))); }
    catch { return fail('validation_failed', 'Vínculo de etapas inválido.', 422, { requestId }); }
    const required = form?.get('required') ?? 'true';
    if (required !== 'true' && required !== 'false') return fail('validation_failed', 'Modo de envio inválido.', 422, { requestId });
    const repeat = form?.get('allow_requested_repeat') ?? 'false';
    if (repeat !== 'true' && repeat !== 'false') return fail('validation_failed', 'Modo de reenvio inválido.', 422, { requestId });
    const description = audioDescriptionSchema.safeParse({ title: form?.get('title'), use_when: form?.get('use_when'),
      stage_ids: stageIds, required: required === 'true', allow_requested_repeat: repeat === 'true', trigger_type: form?.get('trigger_type') ?? 'topic', send_when: form?.get('send_when') ?? '' });
    if (!(file instanceof File) || !description.success || !file.size) {
      return fail('validation_failed', 'Informe arquivo, título e quando o agente deve usar a mídia.', 422, { requestId });
    }
    if (description.data.stage_ids.some(stage => !stages.some(s => s.id === stage))) {
      return fail('validation_failed', 'Escolha somente etapas ativas dos funis deste workspace.', 422, { requestId });
    }
    if (file.size > AUDIO_MAX_BYTES) return fail('payload_too_large', 'Arquivo acima de 16 MB.', 413, { requestId });
    const isAudio = !!prerecordedAudioFormat(file.type);
    if (!isAudio && (!unified || !['image/jpeg', 'image/png', 'video/mp4'].includes(file.type)))
      return fail('unsupported_media_type', 'Use áudio, foto JPG/PNG ou vídeo MP4.', 415, { requestId });
    let bytes: Buffer;
    let contentDigest: string;
    try {
      const original = Buffer.from(await file.arrayBuffer());
      contentDigest = createHash('sha256').update(original).digest('hex');
      bytes = isAudio ? await normalizePrerecordedAudio(original, file.type) : original;
    } catch {
      logger.warn('agent_audio_conversion_failed', { requestId });
      return fail('validation_failed', 'Não foi possível preparar o áudio. Verifique o arquivo e tente novamente. Se persistir, confira o ffmpeg do servidor.', 422, { requestId });
    }
    let visual: Awaited<ReturnType<typeof validateApprovedVisual>> | null = null;
    try { if (!isAudio) visual = await validateApprovedVisual(bytes,file.type); }
    catch { return fail('validation_failed', 'Não foi possível decodificar o arquivo. Use JPG/PNG ou MP4 com vídeo H.264 e áudio AAC, de até 16 MB.', 422, { requestId }); }
    audioId = randomUUID();
    uploaded = visual ? `${org}/agent-media/${id}/${audioId}.${visual.ext}` : `${org}/agent-audios/${id}/${audioId}.ogg`;
    const mime = visual?.mime ?? 'audio/ogg';
    const { error: uploadError } = await admin.storage.from('whatsapp-media')
      .upload(uploaded, bytes, { contentType: mime, upsert: false });
    if (uploadError) return fail('internal_error', 'Erro ao guardar mídia. Tente novamente.', 500, { requestId });
    const common = { ...description.data, id: audioId, storage_path: uploaded, size_bytes: bytes.length,
      content_sha256: contentDigest, storage_sha256: createHash('sha256').update(bytes).digest('hex'), enabled: true };
    next = [...audios, visual ? { ...common, type: visual.type, mime: visual.mime } : { ...common, mime: 'audio/ogg' }];
  } else {
    const raw = await req.json().catch(() => null);
    const parsed = mode === 'edit' ? editSchema.safeParse(raw) : removeSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Alteração de mídia inválida.', 422, { requestId });
    audioId = parsed.data.audio_id;
    if (!audios.some(a => a.id === audioId && (unified || mediaKind(a) === 'audio'))) return fail('not_found', 'Mídia não encontrada.', 404, { requestId });
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
        ...(edit?.trigger_type !== undefined ? { trigger_type: edit.trigger_type } : {}),
        ...(edit?.send_when !== undefined ? { send_when: edit.send_when } : {}),
        ...(edit?.allow_requested_repeat !== undefined ? { allow_requested_repeat: edit.allow_requested_repeat } : {}),
        ...(edit?.stage_ids !== undefined ? { stage_ids: edit.stage_ids } : {}) } : a);
  }
  // O corpo carrega o JSON; a URL contém somente a revisão curta controlada pelo banco.
  const update = admin
    .from("ai_agents")
    .update({
      config: {
        ...((agent.config as Record<string, unknown>) ?? {}),
        approved_media: next,
        approved_audios: legacyAudioProjection(next),
      },
    })
    .eq("id", id)
    .eq("organization_id", org)
    .is("archived_at", null)
    .eq("config_revision", agent.config_revision);
  const { data: saved, error: saveError } = await update.select("id").maybeSingle();
  if (saveError || !saved) {
    // Uma resposta perdida pode esconder um commit. Nunca apagar o arquivo nesse caso.
    const rejected = !saveError || /^(?:[0-9A-Z]{5}|PGRST\d+)$/.test(saveError.code ?? "");
    let confirmed = false;
    if (!rejected) {
      const check = await admin
        .from("ai_agents")
        .select("config")
        .eq("id", id)
        .eq("organization_id", org)
        .is("archived_at", null)
        .maybeSingle();
      confirmed =
        !check.error &&
        !!check.data &&
        isDeepStrictEqual(readApprovedMedia(check.data.config), next);
    }
    if (!confirmed) {
      if (uploaded && rejected) {
        const cleanup = await admin.storage.from("whatsapp-media").remove([uploaded]);
        if (cleanup.error)
          logger.warn("agent_media_cleanup_failed", { requestId, operation: mode });
      }
      logger.warn("agent_media_save_failed", {
        requestId,
        operation: mode,
        category: !saveError ? "conflict" : rejected ? "database_rejected" : "outcome_unknown",
        database_code: saveError && rejected ? saveError.code : undefined,
      });
      return fail(
        !saveError ? "state_conflict" : "internal_error",
        !saveError
          ? "O agente foi alterado em outra aba. Atualize a lista e tente novamente."
          : rejected
            ? "Não foi possível salvar o catálogo de mídias. Atualize a lista e tente novamente."
            : "Não foi possível confirmar o salvamento. Atualize a lista antes de tentar novamente.",
        !saveError ? 409 : rejected ? 500 : 503,
        { requestId },
      );
    }
  }
  void audit({ action: 'ai_agent.updated', actorUserId: auth.user.id, organizationId: org,
    resourceType: 'ai_agent', resourceId: id, requestId, metadata: { audio_action: mode, audio_id: audioId, media_action: mode, media_id: audioId } });
  return ok({ saved: true }, { requestId });
}

export const GET = (req: NextRequest, ctx: Context) => handle(req, ctx, 'read');
export const POST = (req: NextRequest, ctx: Context) => handle(req, ctx, 'add');
export const PATCH = (req: NextRequest, ctx: Context) => handle(req, ctx, 'edit');
export const DELETE = (req: NextRequest, ctx: Context) => handle(req, ctx, 'remove');
