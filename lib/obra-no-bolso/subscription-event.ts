/** Estado do produto. Acesso durante o teste nunca comprova conversão paga. */
import { z } from "zod";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

const date = z.iso.datetime({ offset: true });
export const subscriptionEventSchema = z.object({
  version: z.literal(2),
  event_type: z.enum(["trial_started", "subscription_status_checked"]),
  event_id: z.uuid(), product_user_id: z.uuid(),
  occurred_at: date, trial_started_at: date, checked_at: date,
  name: z.string().trim().min(1).max(200), email: z.email().max(254),
  phone: z.string().trim().min(1).max(40),
  status_pagamento: z.string().trim().min(1).max(60),
  em_trial: z.boolean(), access_enabled: z.boolean(),
  trial_ends_at: date.nullable(), access_expires_at: date.nullable(),
}).strict();

export type SubscriptionEvent = z.infer<typeof subscriptionEventSchema>;
export type SubscriptionDecision = "trial" | "paid" | "recover" | "manual";
export const FINAL_CHECK_MS = 96 * 60 * 60 * 1000;

export function classifySubscription(event: SubscriptionEvent): SubscriptionDecision {
  // O evento inicial somente acompanha o teste, mesmo se chegou com atraso.
  if (event.event_type === "trial_started") return "trial";
  const checked = Date.parse(event.checked_at);
  if (checked < Date.parse(event.trial_started_at) + FINAL_CHECK_MS) return "manual";
  if (["suspenso", "cancelado"].includes(event.status_pagamento) && !event.access_enabled) return "recover";
  if (event.em_trial || event.status_pagamento === "trial") return "manual";
  if (event.status_pagamento === "ativo" && event.access_enabled
    && (!event.trial_ends_at || Date.parse(event.trial_ends_at) <= checked)
    && (!event.access_expires_at || Date.parse(event.access_expires_at) > checked)) return "paid";
  return "manual";
}

export function validateSubscriptionEvent(input: unknown, now = Date.now()) {
  const parsed = subscriptionEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, reason: "invalid_subscription_payload" };
  const event = parsed.data;
  const start = Date.parse(event.trial_started_at);
  const checked = Date.parse(event.checked_at);
  const occurred = Date.parse(event.occurred_at);
  if (start > checked || checked > occurred || occurred > now + 300_000
    || (event.event_type === "subscription_status_checked" && checked < start + FINAL_CHECK_MS)) {
    return { ok: false as const, reason: "invalid_subscription_time" };
  }
  const normalized = normalizePhoneBR(event.phone);
  const phone = normalized && /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
  return { ok: true as const, event: { ...event, phone, email: event.email.toLowerCase() },
    phoneVariants: phone ? phoneLookupVariants(phone) : [], decision: classifySubscription(event) };
}

/** Janela exclusiva de proativos. Nunca usar no handler de mensagens recebidas. */
export function nextObraProactiveWindow(now: Date): Date | null {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo",
    weekday: "short", hour: "2-digit", hourCycle: "h23" });
  const allowed = (at: Date) => {
    const parts = formatter.formatToParts(at);
    const day = parts.find(p => p.type === "weekday")?.value;
    const hour = Number(parts.find(p => p.type === "hour")?.value);
    return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day ?? "") && hour >= 8 && hour < 20;
  };
  if (allowed(now)) return null;
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  for (let attempt = 0; attempt < 8 * 24; attempt++) {
    next.setUTCHours(next.getUTCHours() + 1);
    if (allowed(next)) return next;
  }
  throw new Error("proactive_window_unavailable");
}
