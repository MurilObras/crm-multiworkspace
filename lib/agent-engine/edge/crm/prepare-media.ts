import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import type { SendMessageInput } from "./send-message";
import { CrmTransportError } from "./mcp-client";
import { OutboundApprovalRevokedError } from '@/lib/channels/delivery-error';
import { AUDIO_MAX_BYTES, audioPathOwnedBy, readApprovedAudios } from '@/lib/ai/agents/approved-audios';

/** A URL já foi aprovada no turno. O sink exige Storage privado, não media_url.
 * Intenção e conteúdo fixam o objeto; replay persistido nem baixa de novo.
 * Guardas de destino reutilizam a política de saída (incluindo sua limitação
 * documentada de rebinding entre resolver DNS e conectar). Sem redirects.
 */
export async function prepareAgentMedia(
  supabase: SupabaseClient,
  input: SendMessageInput,
  intentId: string,
): Promise<{ media_storage_path: string; media_mime: string; media_size_bytes: number }> {
  const media = input.media;
  if (!media) throw new Error("agent_media_missing");
  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", input.conversationId)
      .eq("organization_id", input.tenantId)
      .maybeSingle();
    if (error || !conversation) throw new Error("agent_media_conversation_not_found");
    let bytes: Buffer;
    let mime: string;
    let size: number;
    if (media.type === 'audio') {
      const { data: agent, error: agentError } = await supabase.from('ai_agents').select('config')
        .eq('id', media.agent_id).eq('organization_id', input.tenantId).is('archived_at', null).maybeSingle();
      const audio = readApprovedAudios(agent?.config).find(a => a.id === media.audio_id && a.enabled
        && audioPathOwnedBy(a, input.tenantId, media.agent_id));
      if (agentError) throw new Error('agent_audio_lookup_failed');
      if (!audio) throw new OutboundApprovalRevokedError();
      const { data: file, error: downloadError } = await supabase.storage.from('whatsapp-media').download(audio.storage_path);
      if (downloadError || !file || file.size > AUDIO_MAX_BYTES || file.size !== audio.size_bytes) throw new Error('agent_audio_download_failed');
      bytes = Buffer.from(await file.arrayBuffer());
      mime = audio.mime;
      size = bytes.length;
    } else {
      const url = new URL(media.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("agent_media_unsafe_url");
      assertSafeOutboundUrl(media.url);
      await assertDestinoResolvidoSeguro(url.hostname);
      const response = await fetch(media.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error("agent_media_http_failed");
      if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) {
        await response.body?.cancel();
        throw new Error("agent_media_too_large");
      }
      mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const reader = response.body?.getReader();
      if (!reader) throw new Error("agent_media_empty");
      const chunks: Uint8Array[] = [];
      size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_MEDIA_BYTES) throw new Error("agent_media_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const verdict = validateOutboundMedia(mime, size);
      if (!verdict.ok || verdict.kind !== media.type) throw new Error("agent_media_invalid_type");
      bytes = Buffer.concat(chunks);
    }
    // Dois owners podem preparar durante a retomada de lease. Conteúdo distinto
    // usa outro objeto: um owner atrasado não troca o conteúdo em transporte.
    const digest = createHash("sha256").update(mime).update(bytes).digest("hex");
    const path = `${input.tenantId}/${input.conversationId}/agent-${intentId}-${digest}.${extFromMime(mime)}`;
    const { error: uploadError } = await supabase.storage
      .from("whatsapp-media")
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (uploadError) throw new Error("agent_media_upload_failed");
    return { media_storage_path: path, media_mime: mime, media_size_bytes: size };
  } catch (error) {
    if (error instanceof OutboundApprovalRevokedError) throw error;
    // Sem URL, credencial ou corpo externo no log/tool. A fila limita tentativas.
    throw new CrmTransportError("agent_media_prepare_failed");
  }
}
