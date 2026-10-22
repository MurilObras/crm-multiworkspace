import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { createAdminClient } from '@/lib/supabase/admin';
import { ok,fail } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { syncDashboardAds } from '@/lib/dashboard/sync-ads';
import { dashboardQuerySchema } from '@/lib/dashboard/contracts';

export const dynamic='force-dynamic';
const schema=z.object({account_id:z.string().regex(/^act_\d+$/),from:z.iso.date(),to:z.iso.date()}).strict()
  .refine(v=>dashboardQuerySchema.safeParse({from:v.from,to:v.to}).success,{message:'Período inválido.'});
export async function POST(req:NextRequest) {
  const requestId=randomUUID();
  const auth=await requireRole('manager',{requestId,resource:'dashboard_ad_sync'});
  if(!auth.ok)return auth.response;
  const guard=workspaceRequestGuard(req,auth.org.orgId,requestId);if(guard)return guard;
  const parsed=schema.safeParse(await req.json().catch(()=>null));
  if(!parsed.success)return fail('validation_failed','Escolha conta e um período de até 366 dias.',422,{requestId});
  const p=parsed.data;
  let result;
  try{result=await syncDashboardAds(createAdminClient(),auth.org.orgId,p.account_id,p.from,p.to);}
  catch{return fail('internal_error','Não foi possível registrar a consulta de anúncios.',500,{requestId});}
  if(result.status==='busy')return fail('state_conflict','A conta já está sendo consultada ou não tem campanha ativa vinculada.',409,{requestId});
  if(result.status==='failed')return fail('state_conflict','A consulta à Meta falhou. O gasto anterior foi preservado. Confira a conexão de anúncios.',409,{requestId});
  await audit({action:'dashboard.ads_synced',actorUserId:auth.user.id,organizationId:auth.org.orgId,
    resourceType:'ad_account',resourceId:p.account_id,requestId,bypassedRls:true,metadata:{from:p.from,to:p.to,rows:result.rows}});
  return ok(result,{requestId});
}
