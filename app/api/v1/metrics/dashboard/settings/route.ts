import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { roleAtLeast } from '@/lib/auth/types';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { dashboardSettingsSchema, pipelineDashboardSchema } from '@/lib/dashboard/contracts';
import { ok,fail } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export async function GET(req:NextRequest) {
  const requestId=randomUUID();
  const auth=await requireRole('agent',{requestId,resource:'dashboard_settings'});
  if (!auth.ok) return auth.response;
  const workspaceError=workspaceRequestGuard(req,auth.org.orgId,requestId);if(workspaceError)return workspaceError;
  const db=await createClient();
  const manager=roleAtLeast(auth.org.role,'manager');
  const results=await Promise.all([
    db.from('crm_pipelines').select('id,name,is_archived,settings').eq('organization_id',auth.org.orgId).order('position').limit(1001),
    db.from('crm_stages').select('id,name,pipeline_id,is_archived,is_won,is_lost').eq('organization_id',auth.org.orgId).order('position').limit(10001),
    db.from('organizations').select('timezone,settings').eq('id',auth.org.orgId).single(),
    manager?db.from('crm_campaign_assignments').select('account_id,campaign_id,campaign_name,currency,account_timezone,enabled').eq('organization_id',auth.org.orgId).order('campaign_name').limit(1001):Promise.resolve({data:[],error:null}),
    manager?db.from('ai_agents').select('id,name').eq('organization_id',auth.org.orgId).order('name').limit(1001):Promise.resolve({data:[],error:null}),
  ]);
  if (results.some(r=>r.error)) return fail('internal_error','Não foi possível carregar as configurações.',500,{requestId});
  if (results[0].data!.length>1000 || results[1].data!.length>10000 || results[3].data!.length>1000 || results[4].data!.length>1000)
    return fail('validation_failed','Quantidade de funis ou etapas excede o limite deste painel.',422,{requestId});
  const pipelines=(results[0].data??[]).map(p=>{
    const config=pipelineDashboardSchema.safeParse(p.settings?.dashboard??{});
    return {id:p.id,name:p.name,is_archived:p.is_archived,dashboard:config.success?config.data:null,config_error:!config.success};
  });
  const organization=results[2].data;
  if(!organization)return fail('internal_error','Workspace não encontrado.',500,{requestId});
  return ok({pipelines,stages:results[1].data??[],campaigns:results[3].data??[],agents:results[4].data??[],timezone:organization.timezone,
    confirmed_payment_conversions:organization.settings?.dashboard?.confirmed_payment_conversions===true,
    conversions_configured:typeof organization.settings?.dashboard?.confirmed_payment_conversions==='boolean'},{requestId});
}
export async function PATCH(req:NextRequest) {
  const requestId=randomUUID();
  const auth=await requireRole('manager',{requestId,resource:'dashboard_settings'});
  if (!auth.ok) return auth.response;
  const workspaceError=workspaceRequestGuard(req,auth.org.orgId,requestId);if(workspaceError)return workspaceError;
  const body=await req.json().catch(()=>null);
  const parsed=dashboardSettingsSchema.safeParse(body);
  if (!parsed.success) return fail('validation_failed','Confira as etapas e o nome da quantidade.',422,{requestId});
  const p=parsed.data;
  const result=await createAdminClient().rpc('fn_configure_crm_dashboard',{
    p_org:auth.org.orgId,p_pipeline:p.pipeline_id,p_stages:p.qualified_stage_ids,
    p_quantity_label:p.quantity_label,p_confirmed_conversions:p.confirmed_payment_conversions,
  });
  if (result.error) {
    if(result.error.code==='P0002') return fail('not_found','Funil não encontrado.',404,{requestId});
    if(result.error.code==='22023') return fail('validation_failed','Selecione etapas ativas deste funil.',422,{requestId});
    logger.error('[dashboard] settings failed',{requestId,code:result.error.code});
    return fail('internal_error','Não foi possível salvar as configurações.',500,{requestId});
  }
  await audit({action:'dashboard.settings_updated',actorUserId:auth.user.id,organizationId:auth.org.orgId,
    resourceType:'crm_pipeline',resourceId:p.pipeline_id,requestId,bypassedRls:true,
    metadata:{qualified_stage_ids:p.qualified_stage_ids,confirmed_payment_conversions:p.confirmed_payment_conversions}});
  return ok(result.data,{requestId});
}
