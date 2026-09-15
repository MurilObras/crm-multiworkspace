import type { SupabaseClient } from "@supabase/supabase-js";
import { isWindowOpen } from "@/lib/agent-engine/guardrails/messaging-window";
import { capabilitiesOf } from "./capabilities";
import type { ChannelProvider } from "./types";
import { loadOfficialTemplate, type PreparedOfficialTemplate } from "./official-template";
export type OfficialFollowupTemplate = PreparedOfficialTemplate;

/** Janela é sempre derivada do inbound; enviar template não a reabre. */
export function followupNeedsTemplate(provider: ChannelProvider, lastInboundAt: string | Date | null, now: Date): boolean {
  return !capabilitiesOf(provider).freeformOutsideWindow &&
    !isWindowOpen(now, lastInboundAt ? new Date(lastInboundAt) : null);
}

/** Reusa o espelho e o contrato oficiais. ID é de meta_templates, nunca do
 * catálogo local de textos prontos (message_templates). Leitura fail-closed. */
export async function loadOfficialFollowupTemplate(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  templateId: string | undefined,
  values: Record<string, string> = {},
): Promise<OfficialFollowupTemplate> {
  if (!templateId) throw new Error("messaging_window_closed: followup_fallback_missing");
  try {
    return await loadOfficialTemplate(db, organizationId, channelSessionId, templateId, values);
  } catch (error) {
    if (error instanceof Error) throw new Error(error.message.replace(/^official_template_/, "followup_template_"));
    throw error;
  }
}
