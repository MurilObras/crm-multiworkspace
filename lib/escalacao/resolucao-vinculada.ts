import type pg from "pg";
import { z } from "zod";

export const caseResolutionStateSchema = z.object({
  case_id: z.string().uuid(),
  message_id: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "applied", "partial", "cancelled"]),
  reason: z.string().nullable(),
});
export type CaseResolutionState = z.infer<typeof caseResolutionStateSchema>;
type Database = Pick<pg.Pool, "query">;

/** Intenção com autoridade validada no servidor. Metadata da mensagem não é lido. */
export async function prepareCaseResolution(
  db: Database,
  input: { organizationId: string; messageId: string; caseId: string; actorUserId: string; conversationId: string },
): Promise<CaseResolutionState> {
  const { rows: scope } = await db.query(
    "select id from messages where organization_id=$1 and conversation_id=$2 and id=$3",
    [input.organizationId, input.conversationId, input.messageId],
  );
  if (!scope.length) throw new Error("case_resolution_message_invalid");
  const { rows } = await db.query<{ result: unknown }>(
    "select public.fn_prepare_case_resolution($1,$2,$3,$4) result",
    [input.organizationId, input.messageId, input.caseId, input.actorUserId],
  );
  return caseResolutionStateSchema.parse(rows[0]?.result);
}

/** Revalidação final: não transporta uma resposta de consulta já concluída. */
export async function assertCaseResolutionBeforeTransport(
  db: Database,
  input: { organizationId: string; messageId: string },
): Promise<void> {
  const { rows } = await db.query<{ live: boolean }>(
    "select public.fn_case_resolution_transport_live($1,$2) live",
    [input.organizationId, input.messageId],
  );
  if (rows[0]?.live !== true) throw new Error("case_resolution_no_longer_authorized");
}

/** Recuperação durável: só transaciona estado, nunca chama o canal nem um modelo. */
export async function applyCaseResolution(
  db: Database,
  input: { organizationId: string; messageId: string },
): Promise<CaseResolutionState | null> {
  const { rows } = await db.query<{ result: unknown }>(
    "select public.fn_apply_case_resolution($1,$2) result",
    [input.organizationId, input.messageId],
  );
  const value = rows[0]?.result;
  return value == null ? null : caseResolutionStateSchema.parse(value);
}

export async function readCaseResolution(
  db: Database,
  organizationId: string,
  messageId: string,
): Promise<CaseResolutionState | null> {
  const { rows } = await db.query(
    "select case_id,message_id,status,reason from public.case_resolution_intents where organization_id=$1 and message_id=$2",
    [organizationId, messageId],
  );
  return rows[0] ? caseResolutionStateSchema.parse(rows[0]) : null;
}

/** Só encerra falha comprovadamente anterior à rede; incerteza permanece visível. */
export async function cancelCaseResolution(
  db: Database,
  input: { organizationId: string; messageId: string },
): Promise<void> {
  await db.query("select public.fn_cancel_case_resolution($1,$2)", [input.organizationId, input.messageId]);
}
