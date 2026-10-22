import type { SupabaseClient } from '@supabase/supabase-js';
import type { AtribuicaoDeAnuncio } from '@/lib/leads/atribuicao-de-anuncio';

/** Marcador curto preserva a origem quando o canal omite o referral. Não é
 * clique certificado pela plataforma e jamais é enviado como ctwa_clid. */
export function trackingCode(text:string|null|undefined):string|null {
  return text?.match(/\[ref:([a-f0-9]{24})\]/i)?.[1]?.toLowerCase()??null;
}
export async function captureLeadAttribution(db:SupabaseClient,input:{
  organizationId:string;contactId:string;messageId:string|null;texto:string|null;atribuicao?:AtribuicaoDeAnuncio|null;
},newLeadId:string|null) {
  const referral=input.atribuicao;
  const code=trackingCode(input.texto);
  if(!referral&&!code&&!newLeadId)return;
  const adId=referral?.anuncioId&&/^\d{1,100}$/.test(referral.anuncioId)?referral.anuncioId:null;
  const clickId=referral?.cliqueId&&referral.cliqueId.length<=500?referral.cliqueId:null;
  const result=await db.rpc('fn_capture_dashboard_attribution',{
    p_org:input.organizationId,p_contact:input.contactId,p_message:input.messageId,p_lead:newLeadId,
    p_source:referral?.plataforma??'whatsapp',p_ad:adId,p_click:clickId,p_code:code,
  });
  if(result.error)throw new Error('dashboard_attribution_capture_failed');
}
