// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  handler: vi.fn(),
  buscar: vi.fn(),
  gravar: vi.fn(),
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
    buscarIdempotencia: mocks.buscar,
    gravarIdempotencia: mocks.gravar,
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
  mocks.buscar.mockResolvedValue(null);
  mocks.gravar.mockResolvedValue(undefined);
});

it("sem Idempotency-Key mantém o caminho antigo (sem options idempotentes)", async () => {
  const r = await call();
  expect(r.status).toBe(201);
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  const [, , argsInput, options] = mocks.handler.mock.calls[0]!;
  expect(argsInput).toEqual(input);
  expect(options).toBeUndefined();
  expect(mocks.gravar).not.toHaveBeenCalled();
});

it("com chave nova envia com messageId determinístico, idempotency_key e returnExistingOnConflict", async () => {
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(201);
  const [, , argsInput, options] = mocks.handler.mock.calls[0]!;
  expect(argsInput).toMatchObject({ conversation_id: "c", body: "oi" });
  expect((argsInput as { metadata: Record<string, unknown> }).metadata.idempotency_key).toBe("actor:chave-1");
  expect(options).toMatchObject({ returnExistingOnConflict: true });
  expect(typeof (options as { messageId: string }).messageId).toBe("string");
  expect(mocks.gravar).toHaveBeenCalledTimes(1);
});

it("mesma chave com payload diferente devolve 409 e não envia", async () => {
  mocks.buscar.mockResolvedValue({ request_hash: Buffer.from("0000", "hex"), response_body: {} });
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(409);
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(mocks.gravar).not.toHaveBeenCalled();
});

it("mesma chave com o mesmo payload reusa (handler cuida do replay pela PK)", async () => {
  const hash = hashCanonico(input);
  mocks.buscar.mockResolvedValue({ request_hash: Buffer.from(hash, "hex"), response_body: { resource_id: "m" } });
  const r = await call({ "Idempotency-Key": "chave-1" });
  expect(r.status).toBe(201);
  expect(mocks.handler).toHaveBeenCalledTimes(1);
  const [, , , options] = mocks.handler.mock.calls[0]!;
  expect(options).toMatchObject({ returnExistingOnConflict: true });
});
