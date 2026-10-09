// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), rpc: vi.fn() }));
vi.mock("./subscription-lookup", () => ({ refreshSubscriptionState: mocks.refresh }));
import { prepareObraOutreach } from "./outreach";
const event = { id: "event", organization_id: "trusted-org", payload: { contact_id: "contact" } } as unknown as EventRow;
let item: unknown;
const admin = { rpc: mocks.rpc, from: () => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: item, error: null }) }; return q;
} } as unknown as SupabaseClient;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime("2026-10-12T12:00:00Z"); vi.clearAllMocks();
  item = { state_id: "state", rule_id: "rule", due_at: "2026-10-12T11:00:00Z" }; mocks.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.useRealTimers());
it("nenhum evento forjado sem ledger autoriza mensagem", async () => {
  item = null;
  expect(await prepareObraOutreach(admin, event)).toMatchObject({ ready: false, result: { status: "skipped" } });
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("reconsulta depois do adiamento e exige guarda de identidade/fase/resposta", async () => {
  expect(await prepareObraOutreach(admin, event)).toMatchObject({ ready: true, contactId: "contact", ruleId: "rule" });
  expect(mocks.refresh).toHaveBeenCalledWith(admin, "trusted-org", "state");
  mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
  expect(await prepareObraOutreach(admin, event)).toMatchObject({ ready: false, result: { status: "skipped" } });
});
it("fim de semana espera segunda-feira sem consultar nem enviar", async () => {
  vi.setSystemTime("2026-10-10T12:00:00Z");
  item = { state_id: "state", due_at: "2026-10-10T11:00:00Z" };
  expect(await prepareObraOutreach(admin, event)).toMatchObject({ ready: false, result: { status: "retry", retry_at: "2026-10-12T11:00:00.000Z" } });
  expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("sem consulta atual não há fallback para o status antigo", async () => {
  mocks.refresh.mockRejectedValueOnce(new Error("offline"));
  await expect(prepareObraOutreach(admin, event)).rejects.toThrow(); expect(mocks.rpc).not.toHaveBeenCalled();
});
