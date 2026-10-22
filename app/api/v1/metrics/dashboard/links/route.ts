import { randomBytes,randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ok,fail } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { campaignDestination,campaignLinkSchema } from '@/lib/dashboard/campaign-links';

export const dynamic='force-dynamic';
export async function GET(req:NextRequest) {
  const requestId=randomUUID();const auth=await requireRole('manager',{requestId,resource:'campaign_links'});
  if(!auth.ok)return auth.response;
  const guard=workspaceRequestGuard(req,auth.org.orgId,requestId);if(guard)return guard;
  const db=await createClient();
  const result=await db.from('crm_campaign_links').select('id,code,account_id,campaign_id,kind,enabled,destination_url,created_at')
    .eq('organization_id',auth.org.orgId).order('created_at',{ascending:false}).limit(101);
  if(result.error)return fail('internal_error','Não foi possível consultar links.',500,{requestId});
  return ok({links:result.data.slice(0,100),has_more:result.data.length>100},{requestId});
}
export async function POST(req:NextRequest) {
  const requestId=randomUUID();const auth=await requireRole('manager',{requestId,resource:'campaign_links'});
  if(!auth.ok)return auth.response;
  const guard=workspaceRequestGuard(req,auth.org.orgId,requestId);if(guard)return guard;
  const parsed=campaignLinkSchema.safeParse(await req.json().catch(()=>null));
  if(!parsed.success)return fail('validation_failed','Confira a campanha, destino e telefone com DDI e DDD.',422,{requestId});
  const p=parsed.data;const db=createAdminClient();const code=randomBytes(12).toString('hex');
  let destination:string;
  try{destination=campaignDestination(p,code);}catch{return fail('validation_failed','Use um endereço HTTPS sem credenciais.',422,{requestId});}
  const campaign=await db.from('crm_campaign_assignments').select('campaign_id').eq('organization_id',auth.org.orgId)
    .eq('account_id',p.account_id).eq('campaign_id',p.campaign_id).eq('enabled',true).maybeSingle();
  if(campaign.error)return fail('internal_error','Não foi possível conferir a campanha.',500,{requestId});
  if(!campaign.data)return fail('validation_failed','Vincule e ative essa campanha primeiro.',422,{requestId});
  const row=await db.from('crm_campaign_links').insert({organization_id:auth.org.orgId,account_id:p.account_id,campaign_id:p.campaign_id,
    code,kind:p.kind,destination_url:destination}).select('id,code,kind').single();
  if(row.error)return fail('internal_error','Não foi possível criar o link.',500,{requestId});
  await audit({action:'dashboard.campaign_linked',actorUserId:auth.user.id,organizationId:auth.org.orgId,resourceType:'campaign_link',
    resourceId:row.data.id,requestId,bypassedRls:true,metadata:{kind:p.kind,campaign_id:p.campaign_id}});
  return ok(row.data,{requestId});
}
export async function PATCH(req:NextRequest) {
  const requestId=randomUUID();const auth=await requireRole('manager',{requestId,resource:'campaign_links'});
  if(!auth.ok)return auth.response;
  const guard=workspaceRequestGuard(req,auth.org.orgId,requestId);if(guard)return guard;
  const p=z.object({id:z.uuid(),enabled:z.boolean()}).strict().safeParse(await req.json().catch(()=>null));
  if(!p.success)return fail('validation_failed','Link inválido.',422,{requestId});
  const result=await createAdminClient().from('crm_campaign_links').update({enabled:p.data.enabled})
    .eq('organization_id',auth.org.orgId).eq('id',p.data.id).select('id').maybeSingle();
  if(result.error)return fail('internal_error','Não foi possível atualizar o link.',500,{requestId});
  if(!result.data)return fail('not_found','Link não encontrado.',404,{requestId});
  await audit({action:'dashboard.campaign_linked',actorUserId:auth.user.id,organizationId:auth.org.orgId,resourceType:'campaign_link',
    resourceId:p.data.id,requestId,bypassedRls:true,metadata:{enabled:p.data.enabled}});
  return ok({saved:true},{requestId});
}
