/**
 * A pergunta que o publish de follow-up precisa fazer ao canal, sem nomear
 * provider nenhum (invariante 1 de `docs/doctrine/restricao-de-canal.md`):
 * "este canal exige template fora da janela de 24h?"
 *
 * A regra `long_wait_needs_template` (em `lib/followup/validate-publish.ts`) só
 * faz sentido nos canais com hetero-restrição: a API oficial (e o parceiro que
 * a intermedia) recusa texto livre fora da janela, então um `action ai_message`
 * alcançável após ≥24h precisa de `fallback_template_id`. O WAHA/QR aceita
 * texto livre a qualquer hora — exigir o fallback ali é bloquear um publish que
 * funcionaria. A capability canônica que distingue os dois é
 * `freeformOutsideWindow`, e é ela que responde aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { capabilitiesOf } from "./capabilities";
import type { ChannelProvider } from "./types";

/** Puro: este provider exige template fora da janela de 24h (hetero-restrição). */
export function providerExigeTemplateForaDaJanela(provider: string): boolean {
  try {
    return !capabilitiesOf(provider as ChannelProvider).freeformOutsideWindow;
  } catch {
    // Provider fora da matriz: assume a restrição (fail-closed), nunca relaxa.
    return true;
  }
}

/**
 * `true` = algum canal da organização exige template fora da janela de 24h.
 *
 * Resolve dos `channel_sessions` da org — o mesmo destino que o follow-up usa
 * para enviar (`resolveSendTarget` em `lib/agent-engine/agent/followup-turn.ts`
 * deriva o canal da conversa do contato, caindo no número ativo da org).
 *
 * Fail-closed: sem conseguir ler os canais (ou org sem canal) devolve `true`,
 * preservando a exigência atual — o afrouxamento só vale com canal resolvido e
 * provadamente de texto livre.
 */
export async function orgExigeTemplateForaDaJanela(
  db: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("provider")
    .eq("organization_id", organizationId);
  if (error) return true;

  const rows = (data ?? []) as Array<{ provider: string | null }>;
  if (rows.length === 0) return true;

  return rows.some(
    (row) => row.provider !== null && providerExigeTemplateForaDaJanela(row.provider),
  );
}
