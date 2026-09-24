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
  chaveDeIdempotencia,
  concluirIdempotencia,
  hashCanonico,
  idRecurso,
  reservarOuReplay,
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

      // O RECURSO é a fonte durável do vínculo chave→payload (sobrevive à
      // limpeza do idempotency_keys). Checar ANTES de reservar: um payload
      // diferente após a limpeza devolve 409 SEM envenenar a reserva — e o
      // payload original continua recuperando a MESMA operação.
      const { data: jaExiste, error: preCheckErr } = await supabase
        .from("messages")
        .select("id, metadata")
        .eq("id", recursoId)
        .eq("organization_id", activeOrg.orgId)
        .maybeSingle();
      if (preCheckErr) {
        // Falha de leitura NÃO é "não existe": interrompe sem reservar/criar/transportar.
        return fail("internal_error", "Não foi possível verificar a operação existente.", 500, { requestId });
      }
      const replay = jaExiste !== null;
      if (replay) {
        const existingHash = (jaExiste as { metadata?: Record<string, unknown> }).metadata?.idempotency_hash;
        if (existingHash !== hash) {
          return fail("idempotency_conflict", "Requisicão repetida com conteúdo divergente.", 409, {
            requestId,
          });
        }
      } else {
        // Reserva a identidade + hash ANTES de criar/enviar: "mesma chave +
        // payload diferente" é 409 mesmo sob concorrência ou crash.
        const reserva = await reservarOuReplay(admin, {
          organizationId: activeOrg.orgId,
          endpoint: ENDPOINT,
          chave,
          hash,
          recursoId,
        });
        if (reserva.tipo === "conflito") {
          return fail("idempotency_conflict", "Requisicão repetida com conteúdo divergente.", 409, {
            requestId,
          });
        }
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
          metadata: { ...(input.metadata ?? {}), idempotency_key: chave, idempotency_hash: hash },
        } as SendMessageInput,
        {
          messageId: recursoId,
          returnExistingOnConflict: true,
        },
      );

      if (!replay) {
        await concluirIdempotencia(admin, {
          organizationId: activeOrg.orgId,
          endpoint: ENDPOINT,
          chave,
          recursoId,
          statusCode: 201,
        });
      }
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
