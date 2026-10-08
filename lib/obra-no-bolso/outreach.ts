import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { nextObraProactiveWindow } from "./subscription-event";
import { refreshSubscriptionState } from "./subscription-lookup";

export async function prepareObraOutreach(admin: SupabaseClient, row: EventRow): Promise<
  { ready: true; contactId: string; ruleId: string | null; stateId: string }
  | { ready: false; result: Omit<HandlerResult, "consumer_key"> }> {
  const { data: item, error } = await admin.from("obra_subscription_outreach")
    .select("state_id,rule_id,due_at").eq("organization_id", row.organization_id).eq("event_id", row.id).maybeSingle();
  if (error) throw new Error("obra_outreach_unavailable");
  if (!item) return { ready: false, result: { status: "skipped", detail: "obra_outreach_unconfirmed" } };
  const now = new Date();
  const at = new Date(Math.max(now.getTime(), Date.parse(item.due_at)));
  const window = nextObraProactiveWindow(at);
  if (at.getTime() > now.getTime() || window) return { ready: false,
    result: { status: "retry", retry_at: (window ?? at).toISOString() } };
  await refreshSubscriptionState(admin, row.organization_id, item.state_id);
  const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : "";
  const { data: live, error: liveError } = await admin.rpc("fn_obra_outreach_send_live", {
    p_org: row.organization_id, p_event: row.id, p_contact: contactId, p_rule: item.rule_id,
  });
  if (liveError) throw new Error("obra_outreach_guard_unavailable");
  if (live !== true) return { ready: false, result: { status: "skipped", detail: "obra_outreach_no_longer_eligible" } };
  return { ready: true, contactId, ruleId: item.rule_id, stateId: item.state_id };
}

/** Também usado na retomada de uma mensagem preparada: o snapshot antigo não basta. */
export async function refreshObraOutreachForTransport(admin: SupabaseClient, org: string, eventId: string) {
  const { data: item, error } = await admin.from("obra_subscription_outreach")
    .select("state_id").eq("organization_id", org).eq("event_id", eventId).maybeSingle();
  if (error || !item) throw new Error("obra_outreach_unavailable");
  await refreshSubscriptionState(admin, org, item.state_id);
}
