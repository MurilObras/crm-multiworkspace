import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { historyQuerySchema, queryKiwifyHistory } from "@/lib/automation/kiwify-history";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!auth.ok) return auth.response;
  const parsed = historyQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_error", "Revise os filtros informados.", 400, { requestId });
  let db: PoolClient | undefined;
  try {
    db = await getRequestPool().connect();
    await db.query("begin read only");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[auth.user.id]);
    await db.query("set local role authenticated");
    const result = await queryKiwifyHistory(db,auth.org.orgId,parsed.data);
    await db.query("commit");
    return ok(result, { requestId });
  } catch {
    await db?.query("rollback").catch(() => undefined);
    return fail("internal_error", "Não foi possível consultar o histórico.", 500, { requestId });
  } finally { db?.release(); }
}
