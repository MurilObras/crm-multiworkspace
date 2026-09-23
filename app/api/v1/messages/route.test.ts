// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  handler: vi.fn(),
  reservar: vi.fn(),
  concluir: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/schemas", () => ({
  sendMessageSchema: {},
  validateRequest: async () => ({ conversation_id: "c", type: "text", body: "oi" }),
}));
vi.mock("./_handler", () => ({ sendMessageHandler: mocks.handler }));
vi.mock("@/lib/api/idempotency", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/idempotency")>();
  return {
    ...original,
    reservarOuReplay: mocks.reservar,
    concluirIdempotencia: mocks.concluir,
  };
});

import { POST } from "./route";
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

it("reserva a identidade ANTES de enviar, com messageId determinístico e returnExistingOnConflict", async () => {
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(201);
  // Reserva vem antes do envio (ordem dos mocks no fluxo).
  expect(mocks.reservar).toHaveBeenCalledTimes(1);
  expect(mocks.reservar.mock.invocationCallOrder[0]!).toBeLessThan(mocks.handler.mock.invocationCallOrder[0]!);

  const [, , argsInput, options] = mocks.handler.mock.calls[0]!;
  expect(argsInput).toMatchObject({ conversation_id: "c", body: "oi" });
  expect((argsInput as { metadata: Record<string, unknown> }).metadata.idempotency_key).toBe("actor:chave-1");
  expect(options).toMatchObject({ returnExistingOnConflict: true });
  expect((options as { messageId: string }).messageId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(mocks.concluir).toHaveBeenCalledTimes(1);
});

it("reserva devolve conflito → 409 e não envia", async () => {
  mocks.reservar.mockResolvedValue({ tipo: "conflito" });
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(409);
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(mocks.concluir).not.toHaveBeenCalled();
});

it("reserva devolve replay → reutiliza o recurso (handler cuida do dedup pela PK)", async () => {
  mocks.reservar.mockResolvedValue({ tipo: "replay", recursoId: "irrelevante" });
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(201);
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  const [, , , options] = mocks.handler.mock.calls[0]!;
  expect(options).toMatchObject({ returnExistingOnConflict: true });
  expect((options as { messageId: string }).messageId).toMatch(/^[0-9a-f-]{36}$/);
});
