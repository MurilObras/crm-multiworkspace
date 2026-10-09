/** Consulta restrita ao backend do produto; não usa tokens de cliente/provedor. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { fingerprintAccessEvent, readAccessBody } from "./access-event";
import { validateSubscriptionEvent } from "./subscription-event";
import { SubscriptionLookupUnavailableError } from "./subscription-errors";

// Origem do backend já usada pelo frontend do aplicativo. Sem URL arbitrária/SSRF.
export const SUBSCRIPTION_LOOKUP_URL = "https://api.obranobolsoai.com/api/v1/crm/subscription-status";
export function signLookup(raw: Buffer, timestamp: string, secret: string, domain: "lookup" | "snapshot") {
  return "v1=" + createHmac("sha256", secret).update(`${domain}.${timestamp}.`).update(raw).digest("hex");
}

export async function fetchSubscriptionSnapshot(productUserId: string, secret: string,
  now = Date.now(), transport: typeof fetch = fetch) {
  if (!z.uuid().safeParse(productUserId).success || secret.length < 32) throw new Error("subscription_lookup_invalid");
  const stamp = String(Math.floor(now / 1000));
  const body = Buffer.from(JSON.stringify({ product_user_id: productUserId }));
  let response: Response;
  try {
    response = await transport(SUBSCRIPTION_LOOKUP_URL, { method: "POST", body,
      headers: { "Content-Type": "application/json", "X-Obra-Timestamp": stamp,
        "X-Obra-Signature": signLookup(body, stamp, secret, "lookup") },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    // A origem e o input já são fixos/validados. Não persistir erro livre da rede.
    throw new SubscriptionLookupUnavailableError();
  }
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    throw new SubscriptionLookupUnavailableError();
  }
  if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new Error("subscription_lookup_unavailable");
  }
  let raw: Buffer;
  try {
    raw = await readAccessBody(new Request(SUBSCRIPTION_LOOKUP_URL, { method: "POST", body: response.body, duplex: "half" } as RequestInit));
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))) {
      throw new SubscriptionLookupUnavailableError();
    }
    throw error;
  }
  const receivedStamp = response.headers.get("x-obra-timestamp") ?? "";
  const signature = response.headers.get("x-obra-signature") ?? "";
  const current = Date.now();
  if (!/^\d{10,11}$/.test(receivedStamp) || Math.abs(current - Number(receivedStamp) * 1000) > 300_000
    || !/^v1=[a-f0-9]{64}$/.test(signature)
    || !timingSafeEqual(Buffer.from(signature.slice(3), "hex"), Buffer.from(signLookup(raw, receivedStamp, secret, "snapshot").slice(3), "hex"))) {
    throw new Error("subscription_snapshot_untrusted");
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new Error("subscription_snapshot_invalid"); }
  const envelope = z.object({ data: z.unknown() }).strict().safeParse(input);
  const result = validateSubscriptionEvent(envelope.success ? envelope.data.data : null, current);
  if (!result.ok || result.event.product_user_id !== productUserId
    || Math.abs(current - Date.parse(result.event.checked_at)) > 120_000) throw new Error("subscription_snapshot_invalid");
  return { ...result, raw };
}

/** A origem da organização é a sessão/job, nunca um campo fornecido pelo produto. */
export async function refreshSubscriptionState(admin: SupabaseClient, organizationId: string, stateId: string) {
  const { data: state, error } = await admin.from("obra_subscription_states")
    .select("id,integration_id,product_user_id").eq("organization_id", organizationId).eq("id", stateId).maybeSingle();
  if (error || !state) throw new Error("subscription_state_unavailable");
  const { data: integration, error: configError } = await admin.from("obra_access_integrations")
    .select("id,is_active,lifecycle_enabled,secret_encrypted").eq("organization_id", organizationId)
    .eq("id", state.integration_id).maybeSingle();
  if (configError || !integration?.is_active || !integration.lifecycle_enabled || !integration.secret_encrypted) {
    throw new Error("subscription_integration_unavailable");
  }
  const secret = await decryptWebhookSecret(admin, integration.secret_encrypted);
  if (!secret) throw new Error("subscription_key_unavailable");
  const snapshot = await fetchSubscriptionSnapshot(state.product_user_id, secret);
  const { data: received, error: receiveError } = await admin.rpc("fn_receive_obra_subscription", {
    p_org: organizationId, p_integration: integration.id, p_payload: snapshot.event,
    p_fingerprint: fingerprintAccessEvent(snapshot.raw), p_phone_variants: snapshot.phoneVariants,
    p_secret_encrypted: integration.secret_encrypted,
  });
  if (receiveError || received?.status !== "accepted" || received.state_id !== stateId) {
    throw new Error("subscription_refresh_not_applied");
  }
  return received as { status: string; state_id: string; decision: string; reason: string | null };
}
