import type { Pool } from "pg";
import { TIPOS_DERIVAVEIS } from "./derivable";

/** Reprocessa somente o arquivo. Nunca cria inbound_turn nem toca na conversa. */
export async function reprocessMedia(pool: Pool, orgId: string, messageId: string): Promise<"queued" | "busy" | "ineligible"> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const { rows } = await db.query<{
      type: string; direction: string; media_mime: string | null; media_storage_path: string | null;
      media_derived_status: string | null; revoked_at: string | null; metadata: Record<string, unknown> | null;
    }>(`select type,direction,media_mime,media_storage_path,media_derived_status,revoked_at,metadata
        from messages where organization_id=$1 and id=$2 for update nowait`, [orgId, messageId]);
    const msg = rows[0];
    if (!msg || msg.direction !== "inbound" || msg.revoked_at || !msg.media_storage_path ||
      (msg.type === "document" && msg.media_mime?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") ||
      msg.metadata?.responsible_internal === true || msg.media_derived_status !== "failed" || !TIPOS_DERIVAVEIS.has(msg.type)) {
      await db.query("rollback"); return "ineligible";
    }
    const active = await db.query(`select id from event_log where organization_id=$1 and entity_id=$2
      and event_type='media.derive_requested' and status in ('pending','processing') for update nowait`, [orgId, messageId]);
    if (active.rows.length) { await db.query("rollback"); return "busy"; }
    await db.query(`update messages set media_derived_status='pending',media_derived_text=null
      where organization_id=$1 and id=$2`, [orgId, messageId]);
    await db.query(`select public.emit_event('media.derive_requested','message',$2::uuid,
      jsonb_build_object('message_id',($2::uuid)::text),'{"source":"manual_media_reprocess"}'::jsonb,$1)`, [orgId, messageId]);
    await db.query("commit");
    return "queued";
  } catch (error) {
    await db.query("rollback");
    if (typeof error === "object" && error !== null && "code" in error && error.code === "55P03") return "busy";
    throw error;
  } finally { db.release(); }
}
