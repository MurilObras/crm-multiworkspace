import type { SupabaseClient } from "@supabase/supabase-js";
import { isWindowOpen } from "@/lib/agent-engine/guardrails/messaging-window";
import { capabilitiesOf } from "./capabilities";
import type { ChannelProvider } from "./types";
import { isStatusSendable } from "./meta/template-binding";
import { deriveTemplateContract } from "./meta/template-contract";
import { missingSlots } from "./meta/build-components";
import { renderTemplateBody } from "./meta/render-template";

export interface OfficialFollowupTemplate {
  body: string;
  template: { name: string; language: string; values: Record<string, string> };
}

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
  const { data, error } = await db.from("meta_templates")
    .select("name, language, status, components, parameter_format")
    .eq("organization_id", organizationId).eq("channel_session_id", channelSessionId)
    .eq("id", templateId).maybeSingle();
  if (error) throw new Error("followup_template_lookup_failed");
  if (!data) throw new Error("followup_template_not_found");
  if (!isStatusSendable(data.status)) throw new Error("followup_template_not_approved");
  const contract = deriveTemplateContract(data);
  if (missingSlots(contract, values).length) throw new Error("followup_template_missing_values");
  return {
    body: renderTemplateBody(data.components, values, {
      name: data.name, language: data.language, parameterFormat: data.parameter_format,
    }),
    template: { name: data.name, language: data.language, values },
  };
}
