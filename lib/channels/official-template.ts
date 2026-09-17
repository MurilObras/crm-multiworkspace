import type { SupabaseClient } from "@supabase/supabase-js";
import { isStatusSendable } from "./meta/template-binding";
import { deriveTemplateContract } from "./meta/template-contract";
import { missingSlots } from "./meta/build-components";
import { renderTemplateBody } from "./meta/render-template";

export interface PreparedOfficialTemplate {
  body: string;
  template: { name: string; language: string; values: Record<string, string> };
}

/** Definição aprovada por ID, organização e conexão. Compartilhado pelos envios
 * automáticos; nenhum catálogo/contrato de parâmetros paralelo ao espelho. */
export async function loadOfficialTemplate(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  templateId: string,
  values: Record<string, string> = {},
  language?: string,
): Promise<PreparedOfficialTemplate> {
  let query = db.from("meta_templates")
    .select("name, language, status, components, parameter_format")
    .eq("organization_id", organizationId).eq("channel_session_id", channelSessionId)
    .eq("id", templateId);
  if (language !== undefined) query = query.eq("language", language);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("official_template_lookup_failed");
  if (!data) throw new Error("official_template_not_found");
  if (!isStatusSendable(data.status)) throw new Error("official_template_not_approved");
  const contract = deriveTemplateContract(data);
  if (missingSlots(contract, values).length) throw new Error("official_template_missing_values");
  return {
    body: renderTemplateBody(data.components, values, {
      name: data.name, language: data.language, parameterFormat: data.parameter_format,
    }),
    template: { name: data.name, language: data.language, values },
  };
}
