import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", "Caso inválido.", 400, { requestId });
  try {
    const db = getRequestPool();
    const found = await db.query("select id from agent_cases where organization_id=$1 and id=$2", [auth.org.orgId, id]);
    if (!found.rows.length) return fail("not_found", "Caso não encontrado.", 404, { requestId });
    const requests = await db.query(`select r.id,r.kind,r.status,r.created_at,r.delivered_at,p.name as answered_by
      from agent_responsible_requests r left join agent_responsibles p on p.organization_id=r.organization_id and p.id=r.accepted_responsible_id
      where r.organization_id=$1 and r.case_id=$2 order by r.created_at desc`, [auth.org.orgId, id]);
    const deliveries = await db.query(`select d.id,d.request_id,d.purpose,d.status,d.created_at,d.message_id,p.name as responsible_name,
      m.type as format,m.error_code
      from agent_responsible_deliveries d join agent_responsible_requests r on r.organization_id=d.organization_id and r.id=d.request_id
      left join agent_responsibles p on p.organization_id=d.organization_id and p.id=d.responsible_id
      left join messages m on m.organization_id=d.organization_id and m.id=d.message_id
      where r.organization_id=$1 and r.case_id=$2 order by d.created_at`, [auth.org.orgId, id]);
    return ok({ requests: requests.rows, deliveries: deliveries.rows }, { requestId });
  } catch { return fail("unavailable", "Não foi possível consultar as entregas.", 503, { requestId }); }
}
