/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { sendMessageSchema, validateRequest, type SendMessageInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buscarIdempotencia,
  byteaParaHex,
  chaveDeIdempotencia,
  gravarIdempotencia,
  hashCanonico,
  idRecurso,
} from "@/lib/api/idempotency";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/v1/messages";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  let input;
  try {
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const idempotencyKey = req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");

  try {
    if (idempotencyKey) {
      const admin = createAdminClient();
      const chave = chaveDeIdempotencia(user.id, idempotencyKey);
      const hash = hashCanonico(input);
      const recursoId = idRecurso(activeOrg.orgId, user.id, ENDPOINT, idempotencyKey);

      const existente = await buscarIdempotencia(admin, activeOrg.orgId, ENDPOINT, chave);
      if (existente && byteaParaHex(existente.request_hash) !== hash) {
        return fail("idempotency_conflict", "Requisicão repetida com conteúdo divergente.", 409, {
          requestId,
        });
      }

      const message = await sendMessageHandler(
        supabase,
        {
          organization_id: activeOrg.orgId,
          actor: { type: "user", id: user.id },
          requestId,
        },
        {
          ...(input as SendMessageInput),
          metadata: { ...(input.metadata ?? {}), idempotency_key: chave },
        } as SendMessageInput,
        {
          messageId: recursoId,
          returnExistingOnConflict: true,
        },
      );

      await gravarIdempotencia(admin, {
        organizationId: activeOrg.orgId,
        endpoint: ENDPOINT,
        chave,
        hash,
        recursoId,
        statusCode: 201,
      });
      return ok(message, { status: 201, requestId });
    }

    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
      },
      input as SendMessageInput,
    );
    return ok(message, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
