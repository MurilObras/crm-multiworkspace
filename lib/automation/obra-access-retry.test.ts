import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchEvent, registerHandler, type EventRow } from "@/lib/event-log/dispatcher";

const mocks = vi.hoisted(() => ({ readPlan: vi.fn(), freezePlan: vi.fn(), getAction: vi.fn() }));
vi.mock("./action-intent", () => ({ readEventPlan: mocks.readPlan, freezeEventPlan: mocks.freezePlan }));
vi.mock("./actions", () => ({ getAction: mocks.getAction }));
vi.mock("./send-message", () => ({ resumeQueuedAutomationMessage: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "./engine";

const event: EventRow = {
  id: "11111111-1111-4111-8111-111111111111", organization_id: "22222222-2222-4222-8222-222222222222",
  event_type: "obra_access.activated", entity_kind: "crm_lead", entity_id: "33333333-3333-4333-8333-333333333333",
  payload: { modality: "paid" }, metadata: {}, consumed_by: [], attempts: 0,
};
const contactId = "44444444-4444-4444-8444-444444444444";
type Result = { data: unknown; error: { message: string } | null };
function database(failingTable: string | null) {
  const state = { failingTable };
  const rows: Record<string, unknown> = {
    obra_access_receipts: { status: "processed", lead_id: event.entity_id, modality: "paid", contact_id: contactId,
      integration_id: "55555555-5555-4555-8555-555555555555" },
    obra_access_integrations: { is_active: true },
    crm_leads: { id: event.entity_id, contact_id: contactId }, contacts: { id: contactId }, automation_rules: [],
  };
  const client = { from(table: string) {
    const response = (): Result => state.failingTable === table
      ? { data: null, error: { message: "temporary_database_failure" } }
      : { data: rows[table] ?? null, error: null };
    const query = {
      select: () => query, eq: () => query, order: () => query,
      maybeSingle: async () => response(),
      then: (resolve: (result: Result) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return query;
  } } as unknown as SupabaseClient;
  return { state, rows, client };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.readPlan.mockResolvedValue(null); mocks.freezePlan.mockResolvedValue([]);
});

it.each(["obra_access_receipts", "obra_access_integrations", "crm_leads", "contacts"])(
  "falha de leitura em %s permanece retomável e não congela descarte nem envia", async table => {
    const db = database(table);
    registerHandler({ key: AUTOMATION_CONSUMER_KEY, events: [event.event_type],
      handle: row => runAutomationForEvent(db.client, row) });
    const first = await dispatchEvent(event);
    // O drain só consome ok/skipped; error volta para a política existente de retry.
    expect(first).toEqual([expect.objectContaining({ status: "error" })]);
    expect(mocks.freezePlan).not.toHaveBeenCalled();
    expect(mocks.getAction).not.toHaveBeenCalled();
    db.state.failingTable = null;
    expect(await dispatchEvent(event)).toEqual([expect.objectContaining({ status: "ok", detail: "no_match" })]);
    expect(mocks.freezePlan).toHaveBeenCalledOnce();
    expect(mocks.getAction).not.toHaveBeenCalled();
  });

it.each(["missing_receipt", "inactive", "changed_contact"])("%s confirmado continua impedindo envio", async reason => {
  const db = database(null);
  if (reason === "missing_receipt") db.rows.obra_access_receipts = null;
  if (reason === "inactive") db.rows.obra_access_integrations = { is_active: false };
  if (reason === "changed_contact") db.rows.contacts = { id: "outro-contato" };
  expect(await runAutomationForEvent(db.client, event)).toMatchObject({ status: "skipped" });
  expect(mocks.freezePlan).not.toHaveBeenCalled();
  expect(mocks.getAction).not.toHaveBeenCalled();
});
