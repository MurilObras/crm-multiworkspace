import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { ok,fail } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { createAdminClient } from '@/lib/supabase/admin';
import { dashboardDay } from '@/lib/dashboard/period';
import { syncDashboardAds } from '@/lib/dashboard/sync-ads';
import { FUSO_PADRAO,fusoValido } from '@/lib/tempo/fusos';

export const dynamic='force-dynamic';
async function handle(req:NextRequest) {
  const requestId=randomUUID();
  const authorization=req.headers.get('authorization')??'';
  const provided=authorization.startsWith('Bearer ')?authorization.slice(7).trim():'';
  const accepted=[env.INTERNAL_CRON_SECRET,env.INTERNAL_SECRET].filter(Boolean);
  if(!provided||!accepted.includes(provided))return fail('forbidden','Cron secret missing or invalid.',403,{requestId});
  const db=createAdminClient();
  const due=await db.rpc('fn_dashboard_due_ad_account');
  if(due.error)return fail('internal_error','Falha ao consultar sincronizações pendentes.',500,{requestId});
  const row=due.data as {organization_id:string;account_id:string;timezone:string}|null;
  if(!row)return ok({synced:0},{requestId});
  const zone=fusoValido(row.timezone)?row.timezone:FUSO_PADRAO;
  const to=dashboardDay(Date.now(),zone);
  // Revisita atribuição tardia e a virada do mês. Histórico maior é sob demanda.
  const from=new Date(Date.parse(`${to}T12:00:00Z`)-34*86_400_000).toISOString().slice(0,10);
  let result;
  try{result=await syncDashboardAds(db,row.organization_id,row.account_id,from,to);}
  catch{return fail('internal_error','Falha ao persistir sincronização de anúncios.',500,{requestId});}
  if(result.status!=='busy')await audit({action:'dashboard.ads_synced',organizationId:row.organization_id,
    resourceType:'ad_account',resourceId:null,requestId,bypassedRls:true,
    metadata:{account_id:row.account_id,from,to,status:result.status,rows:result.rows}});
  return ok({synced:result.status==='synced'?1:0,status:result.status},{requestId});
}
export const GET=handle;
export const POST=handle;
