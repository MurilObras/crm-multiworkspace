import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Idempotência de escrita reutilizando `idempotency_keys` (UNIQUE
 * organization_id+endpoint+key).
 *
 * Protocolo reserva → executa → conclui:
 *
 *  1. RESERVA atômica: o INSERT grava `request_hash` (o vínculo imutável com o
 *     payload) na MESMA linha e no MESMO passo que a reserva — ANTES de o
 *     recurso existir. Assim, "mesma chave + payload diferente" é detectado
 *     mesmo se o processo cair entre a reserva e a criação do recurso, e sob
 *     concorrência (quem perde o INSERT lê o hash do vencedor → 409).
 *  2. A duplicação do recurso em si é impedida pelo ID DETERMINÍSTICO
 *     (sha256 de org+ator+operação+chave): o PRIMARY KEY do recurso é o
 *     árbitro atômico da concorrência E da recuperação pós-crash. Não há
 *     UNIQUE por texto/produto/nome.
 *  3. CONCLUI marca a reserva como concluída (melhor esforço).
 *
 * Recuperação de cada estado intermediário:
 *  - reservado, recurso ainda não criado (crash): retry vê `replay`/`pendente`
 *    e cria com o MESMO id determinístico (PK dedup) — sem duplicar;
 *  - recurso criado, resposta perdida: retry colide no PK e devolve o existente;
 *  - expiração/limpeza do registro não re-transporta: o id determinístico do
 *    recurso (messages.id) é o que impede repetir a mesma tentativa.
 */

/** Serialização canônica (ordem de chave estável) para o hash de conflito. */
function canonicalizar(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalizar).join(",")}]`;
  if (typeof value === "object") {
    const entradas = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizar(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonico(payload: unknown): string {
  return createHash("sha256").update(canonicalizar(payload)).digest("hex");
}

/**
 * UUID determinístico do recurso, derivado de (org, ator, operação, chave).
 * Dois pedidos com a mesma chave → mesmo id; chaves diferentes (mesmo ator)
 * → ids diferentes (nova ação deliberada continua possível).
 */
export function idRecurso(
  organizationId: string,
  actorId: string,
  endpoint: string,
  clientKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${organizationId}\u0000${actorId}\u0000${endpoint}\u0000${clientKey}`)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50; // versão 5
  digest[8] = (digest[8]! & 0x3f) | 0x80; // variant RFC 4122
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A chave gravada em `idempotency_keys.key`, já vinculada ao ator autenticado. */
export function chaveDeIdempotencia(actorId: string, clientKey: string): string {
  return `${actorId}:${clientKey}`;
}

/** Normaliza o `request_hash` (bytea) lido de volta para hex, para comparação. */
export function byteaParaHex(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "string") {
    const m = value.match(/^\\x([0-9a-f]+)$/);
    return m ? m[1]! : value;
  }
  return String(value);
}

export type ResultadoDeReserva =
  /** Este pedido é o dono: crie o recurso com `recursoId`. */
  | { tipo: "reservado"; recursoId: string }
  /** Chave já reservada com o MESMO payload: reutilize o recurso existente. */
  | { tipo: "replay"; recursoId: string }
  /** Chave já reservada com payload DIFERENTE: 409, sem novo efeito. */
  | { tipo: "conflito" };

/**
 * Reserva a identidade da operação ATOMICAMENTE com o hash do payload.
 *
 * - INSERT bem-sucedido → este pedido é o dono (`reservado`).
 * - 23505 (outra requisição já reservou) → lê o hash do vencedor: igual →
 *   `replay`; diferente → `conflito`.
 * - Qualquer OUTRO erro de escrita PROPAGA (não libera execução como se a
 *   chave não existisse).
 */
export async function reservarOuReplay(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    endpoint: string;
    chave: string;
    hash: string;
    recursoId: string;
  },
): Promise<ResultadoDeReserva> {
  const { error } = await admin
    .from("idempotency_keys")
    .insert({
      organization_id: args.organizationId,
      key: args.chave,
      endpoint: args.endpoint,
      // `request_hash` é bytea: o formato de entrada do PostgREST é a string
      // `\x<hex>`. Um `Buffer` aqui vira `{"type":"Buffer","data":[...]}` no
      // `JSON.stringify` do cliente e o hash gravado deixa de bater com o
      // `byteaParaHex` na leitura — "mesma chave, mesmo payload" vira conflito.
      request_hash: `\\x${args.hash}`,
      response_body: { state: "pending", resource_id: args.recursoId },
      status_code: 202,
    })
    .select("id")
    .single();

  if (!error) return { tipo: "reservado", recursoId: args.recursoId };

  if (error.code === "23505") {
    const { data, error: lookupErr } = await admin
      .from("idempotency_keys")
      .select("request_hash, response_body")
      .eq("organization_id", args.organizationId)
      .eq("endpoint", args.endpoint)
      .eq("key", args.chave)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!data) throw error; // sumiu entre o 23505 e o select — tratar como erro
    if (byteaParaHex((data as { request_hash: unknown }).request_hash) !== args.hash) {
      return { tipo: "conflito" };
    }
    return { tipo: "replay", recursoId: args.recursoId };
  }

  throw error;
}

/**
 * Marca a reserva como concluída (melhor esforço). Erro aqui NÃO libera
 * re-execução: o id determinístico do recurso já garante que o efeito é único.
 */
export async function concluirIdempotencia(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    endpoint: string;
    chave: string;
    recursoId: string;
    statusCode: number;
  },
): Promise<void> {
  await admin
    .from("idempotency_keys")
    .update({
      response_body: { state: "done", resource_id: args.recursoId },
      status_code: args.statusCode,
    })
    .eq("organization_id", args.organizationId)
    .eq("endpoint", args.endpoint)
    .eq("key", args.chave);
}
