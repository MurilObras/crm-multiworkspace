import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { roleAtLeast } from '@/lib/auth/types';
import { createClient } from '@/lib/supabase/server';
import { ok, fail } from '@/lib/api/wrappers';
import { aggregateDashboard } from '@/lib/dashboard/aggregate';
import { dashboardQuerySchema } from '@/lib/dashboard/contracts';
import type { DashboardLead, FirstPayment, LeadAttribution, Qualification, DailySpend, PipelineMeasurement,SpendCoverage } from '@/lib/dashboard/contracts';
import { dashboardPeriod } from '@/lib/dashboard/period';
import { FUSO_PADRAO, fusoValido } from '@/lib/tempo/fusos';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await requireRole('agent', { requestId, resource: 'dashboard' });
  if (!auth.ok) return auth.response;
  const workspaceError=workspaceRequestGuard(req,auth.org.orgId,requestId);if(workspaceError)return workspaceError;
  const parsed = dashboardQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail('validation_failed','Filtros inválidos.',422,{ requestId });
  const q = parsed.data;
  const db = await createClient();
  const org = await db.from('organizations').select('timezone').eq('id',auth.org.orgId).single();
  if (org.error) return fail('internal_error','Não foi possível consultar o workspace.',500,{ requestId });
  const timezoneValid = typeof org.data.timezone==='string' && !!org.data.timezone && fusoValido(org.data.timezone);
  const timezone = timezoneValid ? org.data.timezone as string : FUSO_PADRAO;
  let window: ReturnType<typeof dashboardPeriod>;
  try { window = dashboardPeriod(q.from,q.to,timezone); }
  catch { return fail('validation_failed','Data inválida no fuso do workspace.',422,{ requestId }); }
  const snapshot = await db.rpc('fn_crm_dashboard_inputs', {
    p_org: auth.org.orgId, p_from: window.from, p_to: window.to, p_from_day: q.from, p_to_day: q.to,
    p_pipeline: q.pipeline_id ?? null, p_owner_user: q.owner_user_id ?? null, p_owner_agent: q.owner_agent_id ?? null,
    p_source: q.source ?? null, p_account: q.account_id ?? null, p_campaign: q.campaign_id ?? null,
  });
  if (snapshot.error) {
    if (snapshot.error.code==='54000') return fail('validation_failed','Há muitos negócios neste filtro. Selecione um funil ou responsável.',422,{ requestId });
    logger.error('[dashboard] snapshot failed',{ requestId, code: snapshot.error.code });
    return fail('internal_error','Não foi possível carregar os indicadores.',500,{ requestId });
  }
  const input = snapshot.data as { as_of: string; leads: DashboardLead[]; payments: FirstPayment[];
    attributions: LeadAttribution[]; qualifications: Qualification[]; spend: DailySpend[]; pipeline_measurements: PipelineMeasurement[];coverage:SpendCoverage[] };
  try {
    const result = aggregateDashboard({ query:q, window, ...input, now:input.as_of,
      marketingVisible:roleAtLeast(auth.org.role,'manager') });
    return ok({ ...result, timezone, timezone_fallback:!timezoneValid },{ requestId });
  } catch {
    return fail('validation_failed','Os valores ultrapassam o limite de cálculo seguro. Reduza o período ou os filtros.',422,{requestId});
  }
}
