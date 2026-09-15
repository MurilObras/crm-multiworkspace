import type { SupabaseClient } from "@supabase/supabase-js";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { capabilitiesOf } from "./capabilities";
import { lerEstadoDoCanal } from "./estado";
import type { ChannelProvider, OutboundKind } from "./types";

export interface OutboundSession {
  id: string;
  organization_id: string;
  provider: ChannelProvider;
  status: string;
  archived_at?: string | null;
}

export interface OutboundSelection {
  organizationId: string;
  sessionId?: string;
  kind?: OutboundKind;
  isGroup?: boolean;
}

/** Não há default de número na organização. Uma única elegível é determinística;
 * duas são ambiguidade, não autorização para trocar o remetente do atendimento.
 * A janela de 24h NÃO seleciona conexão: continua sendo responsabilidade do sink. */
export function selectOutboundSession(rows: OutboundSession[], input: OutboundSelection): OutboundSession | null {
  if (input.sessionId !== undefined && !input.sessionId) return null;
  const eligible = rows.filter((row) => {
    if (row.organization_id !== input.organizationId || row.archived_at ||
      !lerEstadoDoCanal(row.status).utilizavel || (input.sessionId && row.id !== input.sessionId)) return false;
    try {
      const caps = capabilitiesOf(row.provider);
      // Template oficial requer plataforma que hospede definições aprovadas.
      if (input.kind === "template" && !caps.requiresTemplates) return false;
      if (input.isGroup && caps.groups === "none") return false;
      return true;
    } catch { return false; }
  });
  return eligible.length === 1 ? eligible[0]! : null;
}

/** Lê a sessão explícita ou a conexão já vinculada ao contato antes de considerar
 * os canais da organização. Vínculo inutilizável não autoriza fallback. */
export async function resolveOutboundSession(
  db: SupabaseClient,
  input: OutboundSelection & { contactId?: string; conversationId?: string },
): Promise<OutboundSession | null> {
  if (input.sessionId !== undefined && !input.sessionId) return null;
  let sessionId = input.sessionId;
  if (input.conversationId !== undefined) {
    if (!input.conversationId) return null;
    let q = db.from('conversations').select('channel_session_id')
      .eq('id', input.conversationId).eq('organization_id', input.organizationId).eq('is_group', false);
    if (input.contactId) q = q.eq('contact_id', input.contactId);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`outbound_conversation_lookup_failed: ${error.message}`);
    if (!data?.channel_session_id || (sessionId && sessionId !== data.channel_session_id)) return null;
    sessionId = data.channel_session_id;
  } else if (!sessionId && input.contactId) {
    const { data, error } = await db.from("conversations")
      .select("channel_session_id").eq("organization_id", input.organizationId)
      .eq("contact_id", input.contactId).eq("is_group", false);
    if (error) throw new Error(`outbound_conversation_lookup_failed: ${error.message}`);
    const bound = [...new Set((data ?? []).map((r: { channel_session_id: string }) => r.channel_session_id))];
    if (bound.length > 1) return null;
    if (bound.length === 1) {
      if (!bound[0]) return null;
      sessionId = bound[0];
    }
  }
  const base = (archived: boolean) => {
    let q = db.from("channel_sessions")
      .select(`id, organization_id, provider, status${archived ? ", archived_at" : ""}`)
      .eq("organization_id", input.organizationId);
    if (sessionId) q = q.eq("id", sessionId);
    return q;
  };
  const { data, error } = await queryTolerantToMissingArchived(
    () => base(true).is(ARCHIVED_AT, null),
    () => base(false),
  );
  if (error) throw new Error(`outbound_session_lookup_failed: ${error.message}`);
  return selectOutboundSession((data ?? []) as unknown as OutboundSession[], { ...input, sessionId });
}
