import { createHash, randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { kiwifyFingerprint, normalizeKiwify, readKiwifyBody, verifyKiwifySignature } from "@/lib/webhooks/kiwify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ token: string }> };

// Sonda documentada; não confirma recebimento de pedido nem consulta dados.
export async function HEAD() { return ok({ status: "ok" }); }

export async function POST(req: Request, ctx: Context): Promise<Response> {
  const requestId = randomUUID();
  try {
    const { token } = await ctx.params;
    if (!/^[a-f0-9]{64}$/.test(token)) return fail("not_found", "Fonte desconhecida.", 404, { requestId });
    const key = createHash("sha256").update(token).digest("hex");
    const limit = await checkRateLimit(`kiwify:${key}`, 60, 60);
    if (!limit.allowed) return fail("rate_limited", "Tente novamente.", 429, { requestId, headers: { "Retry-After": "60" } });
    const admin = createAdminClient();
    const { data: source, error } = await admin.from("kiwify_integrations")
      .select("id, organization_id, secret_encrypted, is_active")
      .eq("path_token", token).maybeSingle();
    if (error) return fail("internal_error", "Fonte indisponível.", 503, { requestId });
    if (!source?.is_active) return fail("not_found", "Fonte desconhecida.", 404, { requestId });
    const secret = source.secret_encrypted ? await decryptWebhookSecret(admin, source.secret_encrypted) : null;
    if (!secret) return fail("internal_error", "Configuração indisponível.", 503, { requestId });
    const signatures = new URL(req.url).searchParams.getAll("signature");
    if (signatures.length !== 1 || !/^[a-f0-9]{40}$/.test(signatures[0] ?? "")) {
      return fail("unauthenticated", "Assinatura inválida.", 401, { requestId });
    }
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return fail("invalid_request", "JSON obrigatório.", 415, { requestId });
    }
    let payload: unknown;
    try { payload = await readKiwifyBody(req); }
    catch { return fail("invalid_request", "Corpo inválido ou excede 256 KiB.", 400, { requestId }); }
    if (!verifyKiwifySignature(payload, signatures, secret)) return fail("unauthenticated", "Assinatura inválida.", 401, { requestId });
    let order;
    try { order = normalizeKiwify(payload); }
    catch { return fail("invalid_request", "Pedido inválido.", 400, { requestId }); }
    const { data, error: ingestError } = await admin.rpc("fn_ingest_kiwify", {
      p_organization_id: source.organization_id, p_integration_id: source.id,
      p_order: order, p_fingerprint: kiwifyFingerprint(order), p_request_id: requestId,
      // Impede aceitar usando segredo/configuração trocados entre leitura e commit.
      p_secret_encrypted: source.secret_encrypted,
    });
    if (ingestError || !data) return fail("internal_error", "Recebimento não confirmado; tente novamente.", 503, { requestId });
    if (data.status === "configuration_error") return fail("invalid_request", "Configuração incompleta.", 422, { requestId });
    if (data.status === "conflict") return fail("idempotency_conflict", "Identidade recebida com conteúdo divergente.", 409, { requestId });
    if (data.status === "invalid") return fail("invalid_request", "Dados inconsistentes.", 400, { requestId });
    return ok(data, { requestId });
  } catch {
    // Não propagar URL, corpo, segredo ou erro SQL para logger/Sentry/resposta.
    return fail("internal_error", "Recebimento não confirmado; tente novamente.", 503, { requestId });
  }
}
