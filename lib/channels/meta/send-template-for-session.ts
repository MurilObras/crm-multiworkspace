/**
 * Cola entre o handler de mensagens e `sendTemplate`: resolve a linha do espelho e
 * traduz o desfecho em algo que o handler saiba gravar.
 *
 * Fica em `lib/channels/` por causa do invariante 1 da doutrina — carrega nome de
 * provider e a catraca proíbe isso fora daqui. Mas a razão de existir é outra: sem
 * ela, o handler precisaria conhecer `meta_templates`, `bindingState` e o formato do
 * contrato, e viraria o lugar que sabe demais sobre um canal específico.
 *
 * **O bind é reconstruído do próprio espelho.** O chamador manda nome, idioma e
 * valores; o `contract_hash` vem do banco, dos dois lados da comparação. Isso torna a
 * trava por hash um no-op AQUI de propósito: quem precisa dela é a configuração
 * salva (a Fase 4b, quando o follow-up guardar um bind), não um envio pedido agora,
 * com o contrato lido no mesmo instante.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendTemplate } from "./send-template";
import { resolveMetaCreds } from "./credentials";
import { DeliveryRejectedError } from '../delivery-error';

export interface SendTemplateForSessionInput {
  organizationId: string;
  channelSessionId: string;
  /** Destinatário em dígitos E.164, já resolvido pelo adapter. */
  to: string;
  name: string;
  language: string;
  values: Record<string, string>;
}

/**
 * Devolve o `external_id` do envio. **Lança** em qualquer desfecho que não seja
 * sucesso — o handler já tem `catch` que grava `failed` com o motivo, e inventar um
 * segundo caminho de erro aqui duplicaria a tradução.
 *
 * As mensagens carregam o motivo real (contrato obsoleto, valor faltando, recusa da
 * plataforma) porque é isso que o operador lê em `error_message`.
 */
export async function sendTemplateForSession(
  db: SupabaseClient,
  input: SendTemplateForSessionInput,
): Promise<string | null> {
  if (!input.channelSessionId) throw new Error("meta_session_required");
  if (!input.name || !input.language) {
    throw new Error("template_incompleto: nome e idioma são obrigatórios em type=template");
  }

  const { data: linha, error } = await db
    .from("meta_templates")
    .select("name, language, status, contract_hash, components, parameter_format")
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("name", input.name)
    .eq("language", input.language)
    .maybeSingle();

  if (error) throw new DeliveryRejectedError(`template_lookup_failed: ${error.message}`, true);
  let creds;
  try {
    creds = await resolveMetaCreds(db, { organizationId: input.organizationId, channelSessionId: input.channelSessionId });
  } catch {
    throw new DeliveryRejectedError('meta_credentials_lookup_failed', true);
  }
  if (!creds) throw new DeliveryRejectedError("meta_session_credentials_missing");

  const resultado = await sendTemplate({
    phoneNumberId: creds.phoneNumberId,
    token: creds.token,
    graphVersion: creds.graphVersion,
    to: input.to,
    binding: {
      name: input.name,
      language: input.language,
      // Ver o cabeçalho: o hash sai do espelho dos dois lados, então `bindingState`
      // aqui checa existência e aprovação, não obsolescência.
      contractHash: linha?.contract_hash ?? "",
      values: input.values,
    },
    current: linha
      ? {
          name: linha.name,
          language: linha.language,
          contractHash: linha.contract_hash,
          status: linha.status,
          components: linha.components,
          parameterFormat: linha.parameter_format,
        }
      : null,
  });

  if (resultado.sent) return resultado.externalId;

  switch (resultado.reason) {
    case "missing":
      throw new DeliveryRejectedError(`template_missing: ${input.name} (${input.language}) não está no espelho`);
    case "not_approved":
      throw new DeliveryRejectedError(`template_not_approved: ${input.name} (${input.language})`);
    case "stale":
      throw new DeliveryRejectedError(`template_stale: ${input.name} mudou na Meta desde a configuração`);
    case "missing_values":
      throw new DeliveryRejectedError(`template_missing_values: ${resultado.missing.join(", ")}`);
    case "api_error":
      if (resultado.notAccepted) throw new DeliveryRejectedError(`meta_${resultado.code ?? 'erro'}: ${resultado.message}`, resultado.retryable);
      throw new Error(`meta_${resultado.code ?? "erro"}: ${resultado.message}`);
  }
}
