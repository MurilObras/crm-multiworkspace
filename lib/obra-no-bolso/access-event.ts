/** Contrato do primeiro acesso liberado; pagamentos são responsabilidade do produto. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

export const MAX_ACCESS_BODY = 16 * 1024;
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const isoDate = z.iso.datetime({ offset: true });
export const accessEventSchema = z.object({
  version: z.literal(1),
  event_type: z.literal("first_access_granted"),
  event_id: identifier,
  product_user_id: identifier,
  occurred_at: isoDate,
  user_created_at: isoDate,
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254),
  phone: z.string().trim().min(1).max(40),
  plan: z.string().trim().min(1).max(120),
  modality: z.enum(["trial", "paid"]),
  user_status: z.string().trim().min(1).max(60),
  is_new_user: z.boolean(),
  trial_active: z.boolean(),
  trial_ends_at: isoDate.nullable(),
  provider: z.string().trim().min(1).max(60).nullable(),
}).strict();

export type AccessEvent = z.infer<typeof accessEventSchema>;

export function validateAccessEvent(input: unknown, now = Date.now()):
  | { ok: true; event: Omit<AccessEvent, "phone"> & { phone: string | null }; phoneVariants: string[] }
  | { ok: false; reason: string; event: AccessEvent | null } {
  const parsed = accessEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_payload", event: null };
  const event = parsed.data;
  const occurred = Date.parse(event.occurred_at);
  const created = Date.parse(event.user_created_at);
  if (created > occurred || occurred > now + 5 * 60_000) {
    return { ok: false, reason: "invalid_event_time", event };
  }
  if (event.modality === "trial") {
    if (!event.trial_active || !event.trial_ends_at || Date.parse(event.trial_ends_at) <= now) {
      return { ok: false, reason: "trial_not_active", event };
    }
  } else if (event.user_status !== "active" || !event.is_new_user || event.trial_active || event.trial_ends_at) {
    return { ok: false, reason: "paid_user_not_eligible", event };
  }
  const phone = normalizePhoneBR(event.phone);
  const normalized = phone && /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
  return { ok: true, event: { ...event, email: event.email.toLowerCase(), phone: normalized }, phoneVariants: normalized ? phoneLookupVariants(normalized) : [] };
}

/** A assinatura cobre bytes exatos: v1=HMAC_SHA256(timestamp + '.' + raw_body). */
export function verifyAccessSignature(raw: Buffer, timestamp: string | null, signature: string | null,
  secret: string, now = Date.now()): boolean {
  if (!secret || !timestamp || !/^\d{10,13}$/.test(timestamp) || !signature || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const millis = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isSafeInteger(millis) || Math.abs(now - millis) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(raw).digest();
  const received = Buffer.from(signature.slice(3), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function fingerprintAccessEvent(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function readAccessBody(req: Request): Promise<Buffer> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ACCESS_BODY) throw new Error("body_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
