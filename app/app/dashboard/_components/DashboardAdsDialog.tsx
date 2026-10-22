'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useT } from '@/hooks/i18n/useT';
import { dashboardFetch } from '@/lib/dashboard/client';
import type { DashboardSettingsResponse } from '@/lib/dashboard/contracts';

export function DashboardAdsDialog(p:{open:boolean;onOpenChange:(v:boolean)=>void;organizationId:string;settings:DashboardSettingsResponse;from:string;to:string}) {
  const t=useT();const qc=useQueryClient();
  const [account,setAccount]=useState('');const [campaign,setCampaign]=useState('');
  const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
  const [kind,setKind]=useState<'whatsapp'|'website'>('whatsapp');const [destination,setDestination]=useState('');
  const [message,setMessage]=useState('Quero saber mais.');
  const links=useQuery({queryKey:['dashboard-campaign-links',p.organizationId],enabled:p.open,refetchOnWindowFocus:false,
    queryFn:()=>dashboardFetch<{links:Array<{id:string;code:string;campaign_id:string;account_id:string;enabled:boolean;kind:string}>;has_more:boolean}>('/api/v1/metrics/dashboard/links',undefined,p.organizationId)});
  const accounts=useQuery({queryKey:['dashboard-ad-accounts',p.organizationId],
    queryFn:()=>dashboardFetch<{contas:Array<{id:string;nome:string;moeda:string}>}>('/api/v1/ads/meta/accounts',undefined,p.organizationId),
    enabled:p.open,staleTime:300_000,refetchOnWindowFocus:false,retry:false});
  const campaigns=useQuery({queryKey:['dashboard-ad-catalog',p.organizationId,account],
    queryFn:()=>dashboardFetch<Array<{id:string;name:string}>>(`/api/v1/metrics/dashboard/campaigns?account_id=${encodeURIComponent(account)}`,undefined,p.organizationId),
    enabled:p.open&&!!account,staleTime:300_000,refetchOnWindowFocus:false,retry:false});
  const refresh=()=>Promise.all([qc.invalidateQueries({queryKey:['dashboard-settings',p.organizationId]}),qc.invalidateQueries({queryKey:['dashboard',p.organizationId]})]);
  const mutate=async(path:string,body:unknown,success:string,method='POST')=>{
    setBusy(true);setError('');setNotice('');
    try{await dashboardFetch(`/api/v1/metrics/dashboard/${path}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},p.organizationId);
      await refresh();if(path==='links')await links.refetch();setNotice(success);
    }catch(e){setError(e instanceof Error?e.message:t('Não foi possível concluir.'));}finally{setBusy(false);}
  };
  const linkedAccounts=[...new Set(p.settings.campaigns.filter(c=>c.enabled).map(c=>c.account_id))];
  return <Dialog open={p.open} onOpenChange={v=>{if(!busy)p.onOpenChange(v);}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{t('Campanhas e sincronização')}</DialogTitle><DialogDescription>{t('Vincule as campanhas deste workspace para cruzar gastos com pagamentos. Cada campanha pertence a um único workspace.')}</DialogDescription></DialogHeader>
    <Link href="/app/ads/meta" className="text-sm underline">{t('Configurar conexão de leitura Meta')}</Link>
    <div className="space-y-2"><Label htmlFor="link-account">{t('Conta de anúncios')}</Label><select id="link-account" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={account} disabled={busy} onChange={e=>{setAccount(e.target.value);setCampaign('');}}>
      <option value="">{t('Selecione uma conta')}</option>{accounts.data?.contas.map(a=><option key={a.id} value={a.id}>{a.nome} ({a.moeda})</option>)}</select>
      <Label htmlFor="link-campaign">{t('Campanha')}</Label><select id="link-campaign" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={campaign} disabled={!account||busy} onChange={e=>setCampaign(e.target.value)}>
        <option value="">{campaigns.isFetching?t('Consultando…'):t('Selecione uma campanha')}</option>{campaigns.data?.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    {accounts.error||campaigns.error?<p role="alert" className="text-sm">{accounts.error?.message??campaigns.error?.message}</p>:null}
    <Button disabled={busy||!account||!campaign} onClick={()=>mutate('campaigns',{account_id:account,campaign_id:campaign,enabled:true},t('Campanha vinculada. Sincronize o período para carregar os gastos.'))}>{t('Vincular campanha')}</Button>
    <div className="space-y-2 border-t pt-3"><h3 className="text-sm font-medium">{t('Campanhas deste workspace')}</h3>
      {p.settings.campaigns.map(c=><div key={`${c.account_id}:${c.campaign_id}`} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
        <span>{c.campaign_name}<span className="block text-xs text-muted-foreground">{c.currency} · {c.account_timezone} · {c.enabled?t('Sincronização ativa'):t('Sincronização pausada')}</span></span>
        <Button size="sm" variant="outline" disabled={busy} onClick={()=>mutate('campaigns',{account_id:c.account_id,campaign_id:c.campaign_id,enabled:!c.enabled},t('Vínculo atualizado. O histórico foi preservado.'))}>{c.enabled?t('Pausar'):t('Retomar')}</Button></div>)}
      {!p.settings.campaigns.length?<p className="text-sm text-muted-foreground">{t('Nenhuma campanha vinculada.')}</p>:null}</div>
    <div className="space-y-2 border-t pt-3"><h3 className="text-sm font-medium">{t('Consultar gastos do período selecionado')}</h3>
      <p className="text-xs text-muted-foreground">{p.from} → {p.to}. {t('A consulta automática revisita os últimos 35 dias a cada hora. Para períodos anteriores, use os botões abaixo.')}</p>
      <div className="flex flex-wrap gap-2">{linkedAccounts.map(id=><Button key={id} variant="outline" disabled={busy} onClick={()=>mutate('sync',{account_id:id,from:p.from,to:p.to},t('Gastos sincronizados. Os indicadores foram atualizados.'))}>{busy?t('Consultando…'):`${t('Sincronizar')} ${accounts.data?.contas.find(a=>a.id===id)?.nome??id}`}</Button>)}</div></div>
    <div className="space-y-3 border-t pt-3"><h3 className="text-sm font-medium">{t('Links de origem da campanha')}</h3>
      <p className="text-xs text-muted-foreground">{t('Use a conta e campanha selecionadas acima. No WhatsApp, a mensagem preenchida leva a referência. No site, a integração precisa preservar o parâmetro crm_ref no cadastro.')}</p>
      <Label htmlFor="campaign-link-kind">{t('Destino')}</Label><select id="campaign-link-kind" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setDestination('');}}>
        <option value="whatsapp">WhatsApp</option><option value="website">{t('Site ou aplicativo')}</option></select>
      <Label htmlFor="campaign-link-destination">{kind==='whatsapp'?t('Telefone com DDI e DDD, somente números'):t('Endereço HTTPS do site')}</Label>
      <Input id="campaign-link-destination" value={destination} onChange={e=>setDestination(e.target.value)} maxLength={1800}/>
      {kind==='whatsapp'?<><Label htmlFor="campaign-link-message">{t('Mensagem preenchida')}</Label><Input id="campaign-link-message" maxLength={500} value={message} onChange={e=>setMessage(e.target.value)}/></>:null}
      <Button variant="outline" disabled={busy||!account||!campaign||!destination.trim()} onClick={()=>mutate('links',{kind,account_id:account,campaign_id:campaign,
        ...(kind==='whatsapp'?{phone:destination,message}:{url:destination})},t('Link criado. Copie abaixo para usar na campanha.'))}>{t('Criar link')}</Button>
      {links.error?<p role="alert">{links.error.message}</p>:null}
      {links.data?.links.map(l=><div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
        <span>{p.settings.campaigns.find(c=>c.account_id===l.account_id&&c.campaign_id===l.campaign_id)?.campaign_name??t('Campanha')} · {l.kind} · {l.enabled?t('Ativo'):t('Pausado')}</span>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={!l.enabled||busy} onClick={async()=>{
          try{await navigator.clipboard.writeText(`${window.location.origin}/r/${l.code}`);setNotice(t('Link copiado.'));}
          catch{setError(t('Não foi possível copiar.'));}
        }}>{t('Copiar link')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={()=>mutate('links',{id:l.id,enabled:!l.enabled},t('Link atualizado.'),'PATCH')}>{l.enabled?t('Pausar'):t('Retomar')}</Button></div></div>)}
      {links.data?.has_more?<p className="text-xs text-muted-foreground">{t('Mostrando os 100 links mais recentes.')}</p>:null}
    </div>
    {notice?<p role="status" className="text-sm">{notice}</p>:null}{error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
  </DialogContent></Dialog>;
}
