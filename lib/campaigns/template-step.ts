import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOfficialTemplate } from "@/lib/channels/official-template";
import { resolveOutboundSession } from "@/lib/channels/resolve-outbound";
import type { CampaignStep } from "./schema";

export function isTemplateStep(step: CampaignStep): step is Extract<CampaignStep, { type: "template" }> {
  return "type" in step && step.type === "template";
}

/** Uma regra de pré-voo para criação E execução. Revalida na hora do envio porque
 * a aprovação ou o contrato podem ter mudado desde o agendamento. */
export async function prepareCampaignTemplate(
  db: SupabaseClient, organizationId: string, sessionId: string,
  step: Extract<CampaignStep, { type: "template" }>,
) {
  const session = await resolveOutboundSession(db, { organizationId, sessionId, kind: "template" });
  if (!session) throw new Error("campaign_template_channel_unavailable");
  const prepared = await loadOfficialTemplate(db, organizationId, sessionId, step.template_id, step.values, step.language);
  // As RPCs existentes pedem corpo textual não vazio, inclusive no modo lista.
  // Não inventamos texto sentinela para contornar esse contrato.
  if (!prepared.body.trim() || prepared.body.length > 4096) throw new Error("campaign_template_body_invalid");
  return prepared;
}
