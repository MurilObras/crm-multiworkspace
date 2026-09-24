// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  handler: vi.fn(),
  reservar: vi.fn(),
  concluir: vi.fn(),
  preCheck: null as { id: string; metadata?: Record<string, unknown> } | null,
  preCheckError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/schemas", () => ({
  sendMessageSchema: {},
  validateRequest: async () => ({ conversation_id: "c", type: "text", body: "oi" }),
}));
vi.mock("./_handler", () => ({ sendMessageHandler: mocks.handler }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mocks.preCheck, error: mocks.preCheckError }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/api/idempotency", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/idempotency")>();
  return {
    ...original,
    reservarOuReplay: mocks.reservar,
    concluirIdempotencia: mocks.concluir,
  };
});

import { POST } from "./route";
import { hashCanonico } from "@/lib/api/idempotency";
import type { NextRequest } from "next/server";

const input = { conversation_id: "c", type: "text", body: "oi" };
const message = { id: "m", status: "sent", external_id: "wamid-1" };

function call(headers: Record<string, string> = {}) {
  return POST(
    new Request("https://test.invalid/api/v1/messages", { method: "POST", body: JSON.stringify(input), headers }) as unknown as NextRequest,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue({ ok: true, user: { id: "actor" }, org: { orgId: "org" } });
  mocks.handler.mockResolvedValue(message);
  mocks.reservar.mockResolvedValue({ tipo: "reservado", recursoId: "deterministic-id" });
  mocks.concluir.mockResolvedValue(undefined);
  mocks.preCheck = null;
  mocks.preCheckError = null;
});

it("sem Idempotency-Key mantém o caminho antigo (sem options idempotentes)", async () => {
  const r = await call();
  expect(r.status).toBe(201);
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  const [, , argsInput, options] = mocks.handler.mock.calls[0]!;
  expect(argsInput).toEqual(input);
  expect(options).toBeUndefined();
  expect(mocks.reservar).not.toHaveBeenCalled();
});

it("recurso ainda não existe: reserva antes de enviar, com messageId determinístico e hash", async () => {
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(201);
  expect(mocks.reservar).toHaveBeenCalledTimes(1);
  expect(mocks.reservar.mock.invocationCallOrder[0]!).toBeLessThan(mocks.handler.mock.invocationCallOrder[0]!);

  const [, , argsInput, options] = mocks.handler.mock.calls[0]!;
  const metadata = (argsInput as { metadata: Record<string, unknown> }).metadata;
  expect(metadata.idempotency_key).toBe("actor:chave-1");
  expect(metadata.idempotency_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(options).toMatchObject({ returnExistingOnConflict: true });
  expect((options as { messageId: string }).messageId).toMatch(/^[0-9a-f-]{36}$/);
  expect(mocks.concluir).toHaveBeenCalledTimes(1);
});

it("reserva devolve conflito → 409 e não envia", async () => {
  mocks.reservar.mockResolvedValue({ tipo: "conflito" });
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(409);
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(mocks.concluir).not.toHaveBeenCalled();
});

it("recurso JÁ existe com hash igual → replay sem reservar (sobrevive à limpeza)", async () => {
  mocks.preCheck = { id: "deterministic-id", metadata: { idempotency_hash: hashCanonico(input) } };
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(201);
  expect(mocks.reservar).not.toHaveBeenCalled();
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  const [, , , options] = mocks.handler.mock.calls[0]!;
  expect(options).toMatchObject({ returnExistingOnConflict: true });
});

it("recurso JÁ existe com hash DIFERENTE → 409 (payload original não é sobreposto)", async () => {
  mocks.preCheck = { id: "deterministic-id", metadata: { idempotency_hash: hashCanonico({ body: "outro" }) } };
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(409);
  expect(mocks.reservar).not.toHaveBeenCalled();
  expect(mocks.handler).not.toHaveBeenCalled();
});

it("erro de LEITURA no pre-check → 500, sem reservar/criar/transportar", async () => {
  mocks.preCheckError = { message: "conexão indisponível" };
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(500);
  expect(mocks.reservar).not.toHaveBeenCalled();
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(mocks.concluir).not.toHaveBeenCalled();
});

it("permissão revogada antes do replay → 403, e o recurso criado NÃO é devolvido", async () => {
  // Primeira chamada cria o recurso (role ok).
  await call({ "Idempotency-Key": "chave-1" });
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  expect(mocks.reservar).toHaveBeenCalledTimes(1);
  // A permissão é revogada ANTES do retry.
  mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  // Retry com a MESMA chave: o guard de autorização nega antes de qualquer replay.
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(403);
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  expect(mocks.reservar).toHaveBeenCalledTimes(1);
  expect(mocks.concluir).toHaveBeenCalledTimes(1);
});
