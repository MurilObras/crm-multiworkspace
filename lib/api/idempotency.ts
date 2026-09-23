import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Idempotência de escrita reutilizando `idempotency_keys` (migration já
 * existente, UNIQUE (organization_id, endpoint, key)).
 *
 * A DUPLICAÇÃO em si é impedida pelo ID DETERMINÍSTICO do recurso, não por
 * UNIQUE de texto/nome: a chave do cliente vira um `uuid` estável (sha256),
 * então dois pedidos com a MESMA chave derivam o MESMO id — e o `primary key`
 * do recurso (messages.id / automation_rules.id) é o árbitro atômico da
 * concorrência e da recuperação pós-crash. A tabela de idempotência guarda o
 * `request_hash` para detectar "mesma chave, payload diferente" (conflito).
 */

export class ConflitoDeIdempotencia extends Error {
  constructor() {
    super("Requisicão repetida com conteúdo divergente.");
    this.name = "ConflitoDeIdempotencia";
  }
}

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

export interface LinhaDeIdempotencia {
  request_hash: unknown;
  response_body: Record<string, unknown>;
}

export async function buscarIdempotencia(
  admin: SupabaseClient,
  organizationId: string,
  endpoint: string,
  chave: string,
): Promise<LinhaDeIdempotencia | null> {
  const { data, error } = await admin
    .from("idempotency_keys")
    .select("request_hash, response_body")
    .eq("organization_id", organizationId)
    .eq("endpoint", endpoint)
    .eq("key", chave)
    .maybeSingle();
  if (error) throw error;
  return data as LinhaDeIdempotencia | null;
}

/**
 * Grava o resultado do pedido idempotente. Colisão de chave (23505, outro
 * processo venceu a corrida) é esperada e ignorada: o recurso determinístico
 * já garante que só houve UM efeito.
 */
export async function gravarIdempotencia(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    endpoint: string;
    chave: string;
    hash: string;
    recursoId: string;
    statusCode: number;
  },
): Promise<void> {
  const { error } = await admin
    .from("idempotency_keys")
    .insert({
      organization_id: args.organizationId,
      key: args.chave,
      endpoint: args.endpoint,
      request_hash: Buffer.from(args.hash, "hex"),
      response_body: { resource_id: args.recursoId },
      status_code: args.statusCode,
    })
    .select("id")
    .single();
  // 23505 = outro processo venceu a corrida; o recurso determinístico já
  // garante que só houve UM efeito, então a colisão é esperada e ignorada.
  if (error && error.code !== "23505") throw error;
}
