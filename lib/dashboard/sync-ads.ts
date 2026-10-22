import type { SupabaseClient } from '@supabase/supabase-js';
import { lerCredencialDeLeitura } from '@/lib/plataformas-de-anuncio/credenciais-de-leitura';
import { lerContaDoDashboard,lerGastoDiario } from '@/lib/plataformas-de-anuncio/meta/insights';

export type AdSyncResult={status:'synced'|'busy'|'failed';account_id:string;rows:number;reason?:string};

/** Org e conta vêm do vínculo persistido/autorizado, não do corpo de um webhook. */
export async function syncDashboardAds(db:SupabaseClient,org:string,account:string,from:string,to:string):Promise<AdSyncResult> {
  const claim=await db.rpc('fn_claim_dashboard_ad_sync',{p_org:org,p_account:account});
  if(claim.error)throw new Error('dashboard_ad_claim_failed');
  if(!claim.data)return {status:'busy',account_id:account,rows:0};
  const lease=claim.data as {lease_id:string;campaign_ids:string[]};
  const finish=async(rows:unknown[],currency:string,timezone:string,error:string|null)=>{
    const result=await db.rpc('fn_finish_dashboard_ad_sync',{p_org:org,p_account:account,p_lease:lease.lease_id,
      p_from:from,p_to:to,p_campaigns:lease.campaign_ids,p_currency:currency,p_timezone:timezone,p_rows:rows,p_error:error});
    if(result.error)throw new Error('dashboard_ad_persist_failed');
    return result.data===true;
  };
  const fail=async(reason:string):Promise<AdSyncResult>=>{
    await finish([],'','',reason);
    return {status:'failed',account_id:account,rows:0,reason};
  };
  try {
    const credential=await lerCredencialDeLeitura(db,org,'meta_ads');
    if(!credential.ok)return fail(credential.motivo);
    const token=credential.credencial.accessToken;
    const [metadata,spend]=await Promise.all([lerContaDoDashboard(token,account),lerGastoDiario(token,account,from,to)]);
    if(!metadata.ok)return fail(metadata.falha);
    if(!spend.ok)return fail(spend.falha);
    const linked=new Set(lease.campaign_ids);
    const rows=spend.dados.filter(row=>linked.has(row.campaign_id));
    if(rows.some(r=>r.currency!==metadata.dados.currency))return fail('moedas_inconsistentes');
    const persisted=await finish(rows,metadata.dados.currency,metadata.dados.timezone,null);
    return {status:persisted?'synced':'busy',account_id:account,rows:persisted?rows.length:0};
  }catch {
    // Não persistir mensagens brutas do provider: podem conter credenciais.
    return fail('falha_de_sincronizacao');
  }
}
