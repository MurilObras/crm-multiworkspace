import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { ok,fail } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { createAdminClient } from '@/lib/supabase/admin';
import { lerCredencialDeLeitura } from '@/lib/plataformas-de-anuncio/credenciais-de-leitura';
import { lerIdentidadeDeAnuncio } from '@/lib/plataformas-de-anuncio/meta/insights';

export const dynamic='force-dynamic';
async function handle(req:NextRequest) {
  const requestId=randomUUID();const value=req.headers.get('authorization')??'';
  const provided=value.startsWith('Bearer ')?value.slice(7).trim():'';
  if(!provided||![env.INTERNAL_CRON_SECRET,env.INTERNAL_SECRET].filter(Boolean).includes(provided))
    return fail('forbidden','Cron secret missing or invalid.',403,{requestId});
  const db=createAdminClient();
  const result=await db.from('crm_lead_attribution').select('organization_id,lead_id,ad_id').is('campaign_id',null)
    .not('ad_id','is',null).eq('source','meta_ads')
    .or(`resolution_attempted_at.is.null,resolution_attempted_at.lt.${new Date(Date.now()-3_600_000).toISOString()}`)
    .order('resolution_attempted_at',{nullsFirst:true}).order('captured_at').limit(1);
  if(result.error)return fail('internal_error','Falha ao consultar origens pendentes.',500,{requestId});
  const row=result.data[0];if(!row)return ok({resolved:0},{requestId});
  // Org selecionada da fila persistida, nunca de parâmetros externos do cron.
  const attempt=await db.from('crm_lead_attribution').update({resolution_attempted_at:new Date().toISOString()})
    .eq('organization_id',row.organization_id).eq('lead_id',row.lead_id).is('campaign_id',null).select('lead_id');
  if(attempt.error)return fail('internal_error','Falha ao registrar tentativa.',500,{requestId});
  if(!attempt.data.length)return ok({resolved:0},{requestId});
  let resolved=0;
  const credential=await lerCredencialDeLeitura(db,row.organization_id,'meta_ads');
  if(credential.ok) {
    const identity=await lerIdentidadeDeAnuncio(credential.credencial.accessToken,row.ad_id);
    if(identity.ok) {
      const ad=identity.dados;
      const campaign=await db.from('crm_campaign_assignments').select('campaign_name').eq('organization_id',row.organization_id)
        .eq('account_id',ad.account_id).eq('campaign_id',ad.campaign_id).maybeSingle();
      if(campaign.data) {
        const update=await db.from('crm_lead_attribution').update({account_id:ad.account_id,campaign_id:ad.campaign_id,
          campaign_name:campaign.data.campaign_name,adset_id:ad.adset_id})
          .eq('organization_id',row.organization_id).eq('ad_id',row.ad_id).is('campaign_id',null).select('lead_id');
        if(update.error)return fail('internal_error','Falha ao vincular origem.',500,{requestId});
        resolved=update.data.length;
      }
    }
  }
  if(attempt.data.length>0)await audit({action:'dashboard.campaign_linked',organizationId:row.organization_id,resourceType:'crm_lead',
    resourceId:row.lead_id,requestId,bypassedRls:true,metadata:{resolved}});
  return ok({resolved},{requestId});
}
export const GET=handle;export const POST=handle;
