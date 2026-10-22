import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { createAdminClient } from '@/lib/supabase/admin';
import { lerCredencialDeLeitura } from '@/lib/plataformas-de-anuncio/credenciais-de-leitura';
import { lerCampanhas,lerContaDoDashboard } from '@/lib/plataformas-de-anuncio/meta/insights';
import { ok,fail } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';

export const dynamic='force-dynamic';
const schema=z.object({account_id:z.string().regex(/^act_\d+$/),campaign_id:z.string().regex(/^\d+$/),enabled:z.boolean().default(true)}).strict();

export async function GET(req:NextRequest) {
  const requestId=randomUUID();
  const auth=await requireRole('manager',{requestId,resource:'dashboard_campaign'});
  if(!auth.ok)return auth.response;
  const guard=workspaceRequestGuard(req,auth.org.orgId,requestId);if(guard)return guard;
  const parsed=z.object({account_id:schema.shape.account_id}).strict().safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if(!parsed.success)return fail('validation_failed','Selecione uma conta.',422,{requestId});
  const db=createAdminClient();
  const credentials=await lerCredencialDeLeitura(db,auth.org.orgId,'meta_ads');
  if(!credentials.ok)return fail('state_conflict','Conecte a leitura de anúncios em Integrações.',409,{requestId});
  const campaigns=await lerCampanhas(credentials.credencial.accessToken,parsed.data.account_id);
  if(!campaigns.ok)return fail('state_conflict','Não foi possível listar as campanhas. Confira a conexão de anúncios.',409,{requestId});
  return ok(campaigns.dados.filter(c=>c.id&&c.name).map(c=>({id:c.id,name:c.name})),{requestId});
}

/** O vínculo identifica qual workspace responde pela campanha; não altera o anúncio. */
export async function POST(req:NextRequest) {
  const requestId=randomUUID();
  const auth=await requireRole('manager',{requestId,resource:'dashboard_campaign'});
  if(!auth.ok)return auth.response;
  const guard=workspaceRequestGuard(req,auth.org.orgId,requestId);if(guard)return guard;
  const parsed=schema.safeParse(await req.json().catch(()=>null));
  if(!parsed.success)return fail('validation_failed','Selecione conta e campanha válidas.',422,{requestId});
  const db=createAdminClient();
  const p=parsed.data;
  const current=await db.from('crm_campaign_assignments').select('campaign_id').eq('organization_id',auth.org.orgId)
    .eq('account_id',p.account_id).eq('campaign_id',p.campaign_id).maybeSingle();
  if(current.error)return fail('internal_error','Não foi possível consultar o vínculo.',500,{requestId});
  if(!p.enabled) {
    if(!current.data)return fail('not_found','Campanha não vinculada.',404,{requestId});
    const result=await db.from('crm_campaign_assignments').update({enabled:false}).eq('organization_id',auth.org.orgId)
      .eq('account_id',p.account_id).eq('campaign_id',p.campaign_id);
    if(result.error)return fail('internal_error','Não foi possível pausar a sincronização.',500,{requestId});
  }else {
    const credentials=await lerCredencialDeLeitura(db,auth.org.orgId,'meta_ads');
    if(!credentials.ok)return fail('state_conflict','Conecte a leitura de anúncios em Integrações antes de vincular.',409,{requestId});
    const [account,campaigns]=await Promise.all([lerContaDoDashboard(credentials.credencial.accessToken,p.account_id),
      lerCampanhas(credentials.credencial.accessToken,p.account_id)]);
    if(!account.ok||!campaigns.ok)return fail('state_conflict','A Meta não confirmou o acesso à conta e à campanha. Confira a conexão.',409,{requestId});
    const campaign=campaigns.dados.find(c=>c.id===p.campaign_id);
    if(!campaign?.name || campaign.name.length>500)return fail('validation_failed','Campanha não encontrada nessa conta.',422,{requestId});
    // Valores da plataforma; o navegador não escolhe moeda, nome nem fuso.
    const result=await db.from('crm_campaign_assignments').upsert({organization_id:auth.org.orgId,
      account_id:p.account_id,campaign_id:p.campaign_id,campaign_name:campaign.name,currency:account.dados.currency,
      account_timezone:account.dados.timezone,enabled:true},{onConflict:'organization_id,account_id,campaign_id'});
    if(result.error?.code==='23505')return fail('state_conflict','Essa campanha já está vinculada a outro workspace.',409,{requestId});
    if(result.error)return fail('internal_error','Não foi possível salvar o vínculo.',500,{requestId});
  }
  await audit({action:'dashboard.campaign_linked',actorUserId:auth.user.id,organizationId:auth.org.orgId,
    resourceType:'ad_campaign',resourceId:p.campaign_id,requestId,bypassedRls:true,
    metadata:{account_id:p.account_id,enabled:p.enabled}});
  return ok({saved:true},{requestId});
}
