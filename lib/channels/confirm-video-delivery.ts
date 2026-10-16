import type pg from "pg";
import type { Message } from "@/lib/types/messaging";

export class VideoConfirmationConflict extends Error {}

/** Reconciliação do canal, com confirmação HUMANA e sem transporte. Não infere identidade por tamanho/horário:
 * o operador compara as duas mídias e escolhe a confirmação no próprio histórico.
 * Ordem de locks igual ao engine: job -> mensagem -> ledger. Nunca toca job em voo.
 */
export async function confirmVideoDelivery(
  pool: pg.Pool,
  org: string,
  messageId: string,
  echoId: string,
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local lock_timeout='5s'");
    await db.query("set local statement_timeout='10s'");
    const { rows: owners } = await db.query<{ job_id: string }>(
      `select job_id from send_ledger where organization_id=$1 and crm_message_id=$2`,
      [org, messageId],
    );
    if (owners.length !== 1) throw new VideoConfirmationConflict();
    const { rows: jobs } = await db.query<{ status: string; locked_by: string | null }>(
      `select status,locked_by from job_queue where organization_id=$1 and id=$2 for update`,
      [org, owners[0]!.job_id],
    );
    if (!jobs[0] || jobs[0].locked_by || !["done", "failed", "dead"].includes(jobs[0].status))
      throw new VideoConfirmationConflict();
    const { rows } = await db.query<Message & { external_id: string | null }>(
      `select * from messages where organization_id=$1 and id=any($2::uuid[]) order by id for update`,
      [org, [messageId, echoId]],
    );
    const original = rows.find((m) => m.id === messageId),
      echo = rows.find((m) => m.id === echoId);
    if (!original || !echo || original.id === echo.id) throw new VideoConfirmationConflict();
    if (
      original.metadata?.confirmed_echo_id === echoId &&
      echo.metadata?.reconciled_into_message_id === messageId
    ) {
      await db.query("commit");
      return { id: messageId, conversation_id: original.conversation_id, replay: true };
    }
    const phase = (original.metadata?.outbound_attempt as { phase?: string } | undefined)?.phase;
    const sameThread =
      original.conversation_id === echo.conversation_id &&
      original.channel_session_id === echo.channel_session_id &&
      original.contact_id === echo.contact_id;
    const after = new Date(echo.sent_at).getTime() - new Date(original.created_at).getTime();
    if (
      !sameThread ||
      original.type !== "video" ||
      echo.type !== "video" ||
      original.direction !== "outbound" ||
      echo.direction !== "outbound" ||
      original.sent_via !== "ai" ||
      original.status !== "failed" ||
      phase !== "uncertain" ||
      original.external_id ||
      original.revoked_at ||
      echo.revoked_at ||
      original.error_code !== "outbound_delivery_uncertain" ||
      String(echo.sent_via) !== "external_device" ||
      echo.metadata?.fromMe !== true ||
      !echo.external_id ||
      !["sent", "delivered", "read"].includes(echo.status) ||
      echo.metadata?.reconciled_into_message_id ||
      !Number.isFinite(after) ||
      after < 0 ||
      after > 300_000
    ) {
      throw new VideoConfirmationConflict();
    }
    const { rows: sessions } = await db.query(
      `select id from channel_sessions where organization_id=$1 and id=$2 and provider='waha'`,
      [org, original.channel_session_id],
    );
    if (!sessions.length) throw new VideoConfirmationConflict();
    // Conserva a linha de arquivo para FKs/auditoria; só a mensagem original detém
    // o ID do transporte. O eco reconciliado deixa de aparecer como outro envio.
    await db.query(
      `update messages set external_id=null,metadata=coalesce(metadata,'{}'::jsonb)
      || jsonb_build_object('reconciled_into_message_id',$3::text,'original_external_id',external_id)
      where organization_id=$1 and id=$2`,
      [org, echoId, messageId],
    );
    await db.query(
      `update messages set external_id=$3,status=$4,ack=$5,error_code=null,error_message=null,
      sent_at=$6,delivered_at=$7,read_at=$8,
      metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{outbound_attempt,phase}','"confirmed"'::jsonb)
        || jsonb_build_object('confirmed_echo_id',$9::text,'delivery_confirmation','human_verified')
      where organization_id=$1 and id=$2`,
      [
        org,
        messageId,
        echo.external_id,
        echo.status,
        echo.ack,
        echo.sent_at,
        echo.delivered_at,
        echo.read_at,
        echoId,
      ],
    );
    const { rowCount } = await db.query(
      `update send_ledger set status='accepted',last_error=null,updated_at=now()
      where organization_id=$1 and job_id=$2 and crm_message_id=$3 and status='failed'`,
      [org, owners[0]!.job_id, messageId],
    );
    if (rowCount !== 1) throw new VideoConfirmationConflict();
    await db.query(
      `update messages set reply_to_message_id=$3 where organization_id=$1 and conversation_id=$4 and reply_to_message_id=$2`,
      [org, echoId, messageId, original.conversation_id],
    );
    await db.query("commit");
    return { id: messageId, conversation_id: original.conversation_id, replay: false };
  } catch (err) {
    await db.query("rollback");
    throw err;
  } finally {
    db.release();
  }
}
