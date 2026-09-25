import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishedAutomationAgent } from "@/lib/automation/validate-references";
import { schedulingBlockReason } from "@/lib/automation/ai-binding-policy";

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!auth.ok) return auth.response;
  try {
    const admin = createAdminClient();
    const org = auth.org.orgId;
    const [agents, flows] = await Promise.all([
      admin.from("ai_agents").select("id").eq("organization_id", org).is("archived_at", null).not("published_version_id", "is", null),
      admin.from("followup_flow_pointers").select("id,name").eq("organization_id", org).eq("status", "active").not("active_version_id", "is", null),
    ]);
    if (agents.error || flows.error) throw new Error("reference_lookup_failed");
    const published = await Promise.all((agents.data ?? []).map(a => publishedAutomationAgent(admin, org, a.id)));
    return ok({ agents: published.filter(a => a !== null).map(a => ({
      id: a.id, name: a.name, pipeline_ids: a.pipelineIds, scheduling_reason: schedulingBlockReason(a),
    })), followups: flows.data ?? [] }, { requestId });
  } catch { return fail("internal_error", "Não foi possível consultar agentes e follow-ups publicados.", 503, { requestId }); }
}
