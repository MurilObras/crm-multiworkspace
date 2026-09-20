/** Contrato oficial: JSON.parse → JSON.stringify → UTF-8 → HMAC-SHA1 hex.
 * Não passar o payload por Zod/normalização ANTES da autenticação.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

export const KIWIFY_MAX_BODY = 256 * 1024;
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const schema = z.object({
  order_id: identifier,
  store_id: identifier.optional(),
  webhook_event_type: identifier.optional(),
  order_status: identifier.optional(),
  Product: z.object({ product_id: identifier, product_name: optionalText(300) }).optional(),
  Customer: z.object({
    full_name: optionalText(200), email: optionalText(254), mobile: optionalText(40),
  }).nullable().optional(),
});

export function verifyKiwifySignature(payload: unknown, signatures: string[], secret: string): boolean {
  const signature = signatures[0];
  if (!secret || signatures.length !== 1 || !signature || !/^[a-f0-9]{40}$/.test(signature)) return false;
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) return false;
  const expected = createHmac("sha1", secret).update(serialized, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function normalizeKiwify(payload: unknown) {
  const p = schema.parse(payload);
  const customer = p.Customer;
  const text = (v: string | null | undefined) => v?.trim() || null;
  const name = text(customer?.full_name);
  const email = text(customer?.email)?.toLowerCase() ?? null;
  const mobile = text(customer?.mobile);
  // Não transformar texto arbitrário que contém dígitos em destinatário.
  const phone = mobile && /^\+?[\d\s().-]+$/.test(mobile) ? normalizePhoneBR(mobile) : null;
  const validPhone = phone && /^\+[1-9]\d{7,14}$/.test(phone) && !/^(\d)\1+$/.test(phone.slice(-8)) ? phone : null;
  return {
    order_id: p.order_id,
    event_type: p.webhook_event_type ?? "absent",
    order_status: p.order_status ?? "absent",
    product_id: p.Product?.product_id ?? null,
    name: name && !/[\u0000-\u001f\u007f]/.test(name) ? name : null,
    email: email && z.email().safeParse(email).success ? email : null,
    phone: validPhone,
    phone_variants: validPhone ? phoneLookupVariants(validPhone) : [],
    // Só comparação de consistência: nunca resolve o tenant/loja pelo body.
    claimed_store_id: p.store_id ?? null,
  };
}

export type KiwifyOrder = ReturnType<typeof normalizeKiwify>;
export function kiwifyFingerprint(order: KiwifyOrder): string {
  return createHash("sha256").update(JSON.stringify(order)).digest("hex");
}

/** Limite real do stream, inclusive se Content-Length faltar ou mentir. */
export async function readKiwifyBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > KIWIFY_MAX_BODY) throw new Error("body_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export const kiwifyConfigSchema = z.object({
  name: z.string().trim().min(1).max(100),
  store_id: identifier,
  secret: z.string().min(1).max(512),
  pipeline_id: z.uuid(), stage_id: z.uuid(),
  products: z.array(z.object({ external_product_id: identifier, product_id: z.uuid() })).min(1).max(100),
}).strict().refine(p => new Set(p.products.map(m => m.external_product_id)).size === p.products.length);
