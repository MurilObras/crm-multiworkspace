import type pg from "pg";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { acceptResponsibleReply, type Responsible } from "./service";
import { audit } from "@/lib/audit";

/** A mensagem e este job nascem no mesmo commit. Não depende de o webhook
 * continuar executando após persistir a mensagem nem de reentrega do provedor. */
export function createResponsibleReplyHandler(admin: SupabaseClient) {
  return async (job: JobRow, pool: pg.Pool) => {
    const { message_id } = z.object({ message_id: z.string().uuid() }).parse(job.payload);
    const org = job.organization_id;
    const rows = await pool.query<{ id: string; conversation_id: string; channel_session_id: string; media_url: string | null; metadata: Record<string, unknown> }>(
      `select id,conversation_id,channel_session_id,media_url,metadata from messages where organization_id=$1 and id=$2
        and contact_id=$3 and direction='inbound' and metadata->>'responsible_internal'='true'`, [org,message_id,job.contact_id]);
    const m = rows.rows[0]; if (!m) return;
    const responsible = await pool.query<Responsible>("select id,name,phone,enabled from agent_responsibles where organization_id=$1 and id::text=$2", [org,m.metadata.responsible_id]);
    if (!responsible.rows[0]) return;
    const result = await acceptResponsibleReply(pool,{org,session:m.channel_session_id,responsible:responsible.rows[0],message:message_id,
      quoted:typeof m.metadata.responsible_quoted_id === "string" ? m.metadata.responsible_quoted_id : null});
    if (result !== "duplicate") await audit({action:"ai.responsible_reply_received",organizationId:org,resourceType:"message",resourceId:message_id,
      metadata:{responsible_id:responsible.rows[0].id,outcome:result}});
    if (m.media_url) {
      const {error} = await admin.rpc("emit_event",{p_event_type:"media.persist_requested",p_entity_kind:"message",p_entity_id:message_id,
        p_payload:{message_id,conversation_id:m.conversation_id},p_metadata:{source:"responsible_reply"},p_organization_id:org});
      if (error) throw new Error("responsible_media_event_failed");
    }
  };
}
