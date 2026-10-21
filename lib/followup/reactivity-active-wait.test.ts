import { describe, expect, it, vi } from "vitest";
import { applyReactivityEvent, type ReactivityAdminClient, type LiveEnrollmentRef } from "./reactivity";
import type { EventRow } from "@/lib/event-log/dispatcher";

describe("política de resposta em todos os estados vivos", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const event: EventRow = { id: "event", organization_id: "org", event_type: "message.received",
    entity_kind: "message", entity_id: "message", payload: { contact_id: "contact" },
    metadata: {}, consumed_by: [], attempts: 0, created_at: now.toISOString() };
  function client(status: LiveEnrollmentRef["status"], cancel: boolean, started = "2026-10-20T12:00:00Z") {
    const update = vi.fn();
    const db: ReactivityAdminClient = {
      loadLiveEnrollmentsForContact: async () => [{ id: "enr", pointer_id: "flow", status, current_node_id: "wait",
        steps_taken: 2, handoff_policy: "pause", trigger_config: { kind: "manual", cancel_on_reply: cancel }, started_at: started }],
      loadContactBlocked: async () => false, loadConversationContactId: async () => "contact",
      insertEnrollmentEvent: async () => ({ inserted: true }), updateEnrollment: update,
      agoraNoBanco: async () => now.toISOString(),
    };
    return { db, update };
  }
  it.each(["active", "waiting_reply", "paused_handoff", "paused_manual"] as const)("cancela %s", async (status) => {
    const { db, update } = client(status, true);
    await applyReactivityEvent(db, () => now, event);
    expect(update).toHaveBeenCalledWith("enr", "org", expect.objectContaining({ status: "cancelled", outcome: "replied", next_eval_at: null }), expect.anything());
  });
  it.each(["paused_handoff", "paused_manual"] as const)("não acorda %s quando a resposta é consumida", async (status) => {
    const { db, update } = client(status, false);
    await applyReactivityEvent(db, () => now, event);
    expect(update).not.toHaveBeenCalled();
  });
  it("uma espera ativa ainda pode consumir a resposta quando configurada assim", async () => {
    const { db, update } = client("active", false);
    await applyReactivityEvent(db, () => now, event);
    expect(update).toHaveBeenCalledWith("enr", "org", expect.objectContaining({ next_eval_at: now.toISOString() }), expect.anything());
  });
  it("evento antigo não cancela um novo episódio", async () => {
    const { db, update } = client("active", true, "2026-10-21T13:00:00Z");
    await applyReactivityEvent(db, () => now, event);
    expect(update).not.toHaveBeenCalled();
  });
});
