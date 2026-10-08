import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkObraAccessRate } from "@/lib/obra-no-bolso/rate-limit";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { fingerprintAccessEvent, readAccessBody, validateAccessEvent, verifyAccessSignature } from "@/lib/obra-no-bolso/access-event";
import { processObraAccessReceipt } from "@/lib/obra-no-bolso/process-receipt";
import { validateSubscriptionEvent } from "@/lib/obra-no-bolso/subscription-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(req: Request, context: Context): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", "Integração desconhecida.", 404, { requestId });
  let allowed: boolean;
  try { allowed = await checkObraAccessRate(id); }
  catch { return fail("internal_error", "Limite indisponível; tente novamente.", 503, { requestId }); }
  if (!allowed) return fail("rate_limited", "Tente novamente.", 429,
    { requestId, headers: { "Retry-After": "60" } });
  try {
    const admin = createAdminClient();
    const { data: source, error: sourceError } = await admin.from("obra_access_integrations")
      .select("id,organization_id,secret_encrypted,is_active,lifecycle_enabled")
      .eq("id", id).maybeSingle();
    if (sourceError) return fail("internal_error", "Integração indisponível.", 503, { requestId });
    if (!source?.is_active) return fail("not_found", "Integração desconhecida.", 404, { requestId });
    const reject = async (reason: string) => {
      await admin.rpc("fn_reject_obra_access", { p_organization_id: source.organization_id,
        p_integration_id: source.id, p_reason: reason });
    };
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      await reject("content_type");
      return fail("invalid_request", "JSON obrigatório.", 415, { requestId });
    }
    let raw: Buffer;
    try { raw = await readAccessBody(req); }
    catch {
      await reject("body_invalid_or_too_large");
      return fail("invalid_request", "Corpo inválido ou excede 16 KiB.", 400, { requestId });
    }
    const secret = source.secret_encrypted ? await decryptWebhookSecret(admin, source.secret_encrypted) : null;
    if (!secret) return fail("internal_error", "Configuração indisponível.", 503, { requestId });
    if (!verifyAccessSignature(raw, req.headers.get("x-obra-timestamp"),
      req.headers.get("x-obra-signature"), secret)) {
      await reject("invalid_signature");
      return fail("unauthenticated", "Assinatura inválida.", 401, { requestId });
    }
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch {
      await reject("invalid_json");
      return fail("invalid_request", "JSON inválido.", 400, { requestId });
    }
    if (source.lifecycle_enabled) {
      const subscription = validateSubscriptionEvent(input);
      if (!subscription.ok) {
        await reject(subscription.reason);
        return fail("invalid_request", "Evento de acompanhamento inválido.", 422, { requestId });
      }
      const { data: result, error: receiveError } = await admin.rpc("fn_receive_obra_subscription", {
        p_org: source.organization_id, p_integration: source.id, p_payload: subscription.event,
        p_fingerprint: fingerprintAccessEvent(raw), p_phone_variants: subscription.phoneVariants,
        p_secret_encrypted: source.secret_encrypted,
      });
      if (receiveError || !result) return fail("internal_error", "Recebimento não confirmado; tente novamente.", 503, { requestId });
      if (result.status === "conflict") return fail("idempotency_conflict", "ID do evento com conteúdo divergente.", 409, { requestId });
      if (!["accepted", "duplicate"].includes(result.status)) return fail("invalid_request", "Integração inativa ou evento não elegível.", 422, { requestId });
      return ok(result, { requestId });
    }
    const validated = validateAccessEvent(input);
    if (!validated.ok && !validated.event) {
      await reject(validated.reason);
      return fail("invalid_request", "Evento inválido.", 400, { requestId });
    }
    const event = validated.event!;
    const { data: receipt, error: receiptError } = await admin.rpc("fn_receive_obra_access", {
      p_organization_id: source.organization_id, p_integration_id: source.id,
      p_payload: event, p_fingerprint: fingerprintAccessEvent(raw),
      p_phone_variants: validated.ok ? validated.phoneVariants : [],
      p_rejection_reason: validated.ok ? null : validated.reason,
      p_secret_encrypted: source.secret_encrypted,
    });
    if (receiptError || !receipt) return fail("internal_error", "Recebimento não confirmado; tente novamente.", 503, { requestId });
    if (receipt.status === "configuration_error") return fail("invalid_request", "Integração inativa.", 422, { requestId });
    if (receipt.status === "conflict") return fail("idempotency_conflict", "ID do evento com conteúdo divergente.", 409, { requestId });
    if (receipt.status === "rejected") return fail("invalid_request", "Evento não elegível.", 422, { requestId });
    if (receipt.status === "duplicate" && receipt.original_status === "rejected") {
      return fail("invalid_request", "Evento não elegível.", 422, { requestId });
    }
    if (receipt.status === "ready" ||
      (receipt.status === "duplicate" && ["ready", "processing"].includes(receipt.original_status))) {
      try {
        const processed = await processObraAccessReceipt(admin, source.organization_id, source.id, receipt.receipt_id);
        return ok(processed, { requestId });
      } catch {
        return fail("internal_error", "Conversão ainda não confirmada; reenvie o evento.", 503, { requestId });
      }
    }
    return ok({ status: receipt.status, original_status: receipt.original_status ?? null,
      reason: receipt.reason ?? null, receipt_id: receipt.receipt_id }, { requestId });
  } catch {
    // Corpo, segredo, token e erros SQL jamais seguem para logs ou resposta.
    return fail("internal_error", "Recebimento não confirmado; tente novamente.", 503, { requestId });
  }
}
