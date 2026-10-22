import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic='force-dynamic';
/** Código opaco e destino previamente cadastrado por gestor. Não há URL de
 * redirecionamento na query, coleta de IP nem cookie de rastreio neste endpoint. */
export async function GET(_req:Request,context:{params:Promise<{code:string}>}) {
  const {code}=await context.params;
  if(!/^[a-f0-9]{24}$/.test(code))return new Response('Link não encontrado.',{status:404});
  const result=await createAdminClient().from('crm_campaign_links').select('destination_url').eq('code',code).eq('enabled',true).maybeSingle();
  if(result.error)return new Response('Link temporariamente indisponível.',{status:503});
  if(!result.data)return new Response('Link não encontrado.',{status:404});
  let destination:URL;
  try{destination=new URL(result.data.destination_url);if(destination.protocol!=='https:'||destination.username||destination.password)throw new Error('invalid');}
  catch{return new Response('Destino indisponível.',{status:503});}
  return NextResponse.redirect(destination, {status:302,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
