import { describe, expect, it, vi } from "vitest";
import { avancarEnrollmentAtivo, type FollowupJobRequest } from "./engine";
import { actionConfigSchema } from "./graph-schema";

describe("fallback do grafo pinado alcança o job", () => {
  it.each([
    { mode: "text", body: "Oi" },
    { mode: "ai_message", prompt_hint: "retome" },
    { mode: "template", template_id: "22222222-2222-4222-8222-222222222222" },
  ])("%j transporta fallback sem reinterpretar ID nem valores", async (base) => {
    const config = actionConfigSchema.parse({ ...base,
      fallback_template_id: "11111111-1111-4111-8111-111111111111", fallback_template_values: { "1": "Ana" },
    });
    const enqueueJob = vi.fn(async (_job: FollowupJobRequest) => {});
    const db = {
      loadFlowGraph: async () => ({ nodes: [{ id: "a1", type: "action", config }], edges: [] }),
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadEnrollmentEvents: async () => [],
      insertEnrollmentEvent: async () => ({ inserted: true }),
      updateEnrollment: async () => {},
    };
    await avancarEnrollmentAtivo({ db: db as never, enqueueJob, clock: () => new Date("2026-09-15T12:00:00Z") }, {
      id: "enrollment-1", organization_id: "org-1", contact_id: "contact-1", version_id: "version-1",
      current_node_id: "a1", steps_taken: 0, status: "active", attempts: 0,
    } as never);
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ organization_id: "org-1", payload: expect.objectContaining({
      fallback_template_id: config.fallback_template_id, fallback_template_values: { "1": "Ana" },
    }) }));
  });
});
