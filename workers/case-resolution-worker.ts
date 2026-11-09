import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { applyCaseResolution } from "@/lib/escalacao/resolucao-vinculada";
import { z } from "zod";

const KEY = "inbox-case-resolution.v1";
export const caseResolutionHandler: EventHandler = {
  key: KEY,
  events: ["ai.case_resolution_confirmed"],
  async handle(row) {
    const parsed = z.object({ message_id: z.string().uuid() }).safeParse(row.payload);
    if (!parsed.success) return { consumer_key: KEY, status: "error", detail: "case_resolution_event_invalid" };
    const result = await applyCaseResolution(getRequestPool(), {
      organizationId: row.organization_id,
      messageId: parsed.data.message_id,
    });
    if (!result) return { consumer_key: KEY, status: "skipped", detail: "case_resolution_intent_not_found" };
    if (result.status === "confirmed" || result.status === "pending") {
      return { consumer_key: KEY, status: "retry", retry_at: new Date(Date.now() + 30_000).toISOString(),
        detail: result.reason ?? "case_resolution_waiting" };
    }
    return { consumer_key: KEY, status: "ok", detail: result.reason ?? result.status };
  },
};
