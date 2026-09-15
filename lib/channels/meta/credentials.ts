/**
 * Credenciais do canal oficial — **por sessão**, não por instalação.
 *
 * ─── O limite que isto remove ───────────────────────────────────────────────
 * Até aqui `getMetaCreds()` lia `META_PHONE_NUMBER_ID` e `META_SYSTEM_USER_TOKEN`
 * do ambiente. Funciona para quem tem UM número — e torna impossível duas
 * organizações com números oficiais diferentes na mesma instalação, o que contradiz
 * o multi-tenant que o `CLAUDE.md` estabelece desde o dia 1.
 *
 * A credencial passa a viver na linha de `channel_sessions` (colunas criadas pela
 * migration 0087), cifrada pelas MESMAS RPCs que o resto do repo usa
 * (`fn_encrypt_oauth`/`fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`). Escrever um
 * terceiro caminho de cifra seria criar mais um lugar para a chave vazar.
 *
 * ─── Por que o env continua existindo ───────────────────────────────────────
 * Apenas para chamadas legadas SEM `channelSessionId`. Todo envio pelo sink do
 * CRM informa esse ID e usa exclusivamente a credencial da sessão; token ausente
 * ou erro de decifra fecham o envio. O caminho legado fica nomeado (`source: 'env'`).
 *
 * A ordem é sessão-primeiro de propósito: com a credencial gravada, o env deixa de
 * ter efeito. Se fosse o contrário, um env esquecido silenciaria a configuração da
 * tela e o operador não entenderia por que mudou nada.
 *
 * ─── Por que a busca leva a ORGANIZAÇÃO junto (issue #236) ──────────────────
 * `meta_phone_number_id` é identificador do PROVIDER e nada obrigava a ser único
 * na instalação: bastava uma agência conectar a mesma WABA em duas organizações
 * (configuração LEGÍTIMA, não ataque — a rota de conexão só aceita conta que a
 * chave informada alcança) para a busca por ele casar DUAS linhas. Medido contra
 * @supabase/postgrest-js 2.112.1: `maybeSingle()` com 2 linhas devolve
 * `data: null` e `error PGRST116` (HTTP 406) — e o `error` era descartado aqui,
 * então as DUAS organizações passavam a enviar pela conta do `.env`.
 *
 * O conserto tem três camadas, e nenhuma sozinha basta: o filtro de organização
 * (aqui), o índice único parcial da migration 0165 (o banco recusa a colisão) e
 * o invariante `tests/unit/canal-consulta-por-organizacao.test.ts` (o quarto
 * canal não repete).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_META } from "../capabilities";

export interface MetaCredentials {
  phoneNumberId: string;
  token: string;
  graphVersion: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
}

/**
 * A chave da busca. `organizationId` NÃO é decoração: ver o cabeçalho.
 */
export interface MetaCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  /** `channel_sessions.meta_phone_number_id` — o `sessionRef` deste canal. */
  phoneNumberId?: string;
  /** Quando presente, resolução estrita por ID do CRM, sem fallback de ambiente. */
  channelSessionId?: string;
}

/** Versão da Graph API. Explícita de propósito: bump é decisão, não deriva. */
function graphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? "v22.0";
}

/**
 * Credencial do ambiente. `null` quando não configurada — o chamador trata como
 * canal não conectado (noop), nunca como erro.
 */
export function metaCredsFromEnv(): MetaCredentials | null {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!phoneNumberId || !token) return null;
  return { phoneNumberId, token, graphVersion: graphVersion(), source: "env" };
}

/**
 * Credencial da sessão desta ORGANIZAÇÃO que atende este `phone_number_id`.
 *
 * `null` significa "credencial indisponível". Com channelSessionId o chamador
 * deve recusar o envio; só chamadas legadas sem esse ID podem usar env.
 *
 * **LANÇA quando a consulta falha**, e essa é a diferença que a issue #236 pagou.
 * A versão anterior desestruturava só `{ data }` e jogava o `error` fora: com duas
 * linhas casando, o PostgREST devolve `data: null` + `PGRST116` (406), o `null`
 * virava "não tem token gravado" e o envio saía pela conta do `.env` — a de OUTRA
 * instalação, sem nenhum erro em lugar nenhum. Falha de resolução tem de fechar a
 * ação e abrir a informação, não virar caminho feliz de outra conta.
 */
export async function metaCredsForPhoneNumberId(
  admin: SupabaseClient,
  lookup: MetaCredsLookup,
): Promise<MetaCredentials | null> {
  const { organizationId, phoneNumberId, channelSessionId } = lookup;
  if (!organizationId || (channelSessionId !== undefined ? !channelSessionId : !phoneNumberId)) return null;

  // `organization_id` À MÃO: este client é de service role e bypassa RLS.
  // `archived_at is null` acompanha o filtro porque é o MESMO recorte do índice
  // único `channel_sessions_meta_phone_number_id_ativo_unique` (migration 0165) —
  // sem ele a linha arquivada volta a poder duplicar o número e a busca deixa de
  // ser exata justo onde a trava do banco não alcança.
  const base = () => {
    let q = admin
      .from("channel_sessions")
      .select("meta_phone_number_id, meta_token_encrypted")
      .eq("organization_id", organizationId);
    if (channelSessionId !== undefined) {
      q = q.eq("id", channelSessionId).eq("provider", CHANNEL_PROVIDER_META).eq("status", "WORKING");
    }
    if (phoneNumberId) q = q.eq("meta_phone_number_id", phoneNumberId);
    return q;
  };
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `meta_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = data?.meta_token_encrypted;
  if (!data?.meta_phone_number_id || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Falha de decifra não autoriza credencial global no envio session-bound.
  if (!token) return null;

  return {
    phoneNumberId: data.meta_phone_number_id as string,
    token,
    graphVersion: graphVersion(),
    source: "session",
  };
}

/**
 * Com ID do CRM: somente a sessão validada. Sem ID: compatibilidade de chamadas
 * legadas que ainda resolvem por número e permitem fallback de instalação.
 */
export async function resolveMetaCreds(
  admin: SupabaseClient,
  lookup: MetaCredsLookup,
): Promise<MetaCredentials | null> {
  const session = await metaCredsForPhoneNumberId(admin, lookup);
  if (lookup.channelSessionId !== undefined) return session;
  return session ?? metaCredsFromEnv();
}
