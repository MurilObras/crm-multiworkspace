'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/auth/AuthProvider';
import { useT } from '@/hooks/i18n/useT';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { aggregateDashboard } from '@/lib/dashboard/aggregate';
import type { DashboardSettingsResponse } from '@/lib/dashboard/contracts';
import { PaymentDialog } from './PaymentDialog';
import { DashboardSettingsDialog } from './DashboardSettingsDialog';
import { DashboardAdsDialog } from './DashboardAdsDialog';
import { dashboardFetch,dashboardMoney as money } from '@/lib/dashboard/client';

export type DashboardData=ReturnType<typeof aggregateDashboard>&{timezone:string;timezone_fallback:boolean};
function Metric({label,value,note}:{label:string;value:string|number;note?:string}) {
  return <div className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{label}</p>
    <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>{note?<p className="mt-2 text-xs text-muted-foreground">{note}</p>:null}</div>;
}

export function DashboardClient(props:{organizationId:string;currentUserId:string;canManage:boolean;initialFrom:string;initialTo:string}) {
  const t=useT();
  const {activeOrg}=useAuth();
  const [from,setFrom]=useState(props.initialFrom);
  const [to,setTo]=useState(props.initialTo);
  const [view,setView]=useState<'payments'|'acquisition'>('acquisition');
  const [pipeline,setPipeline]=useState('');
  const [owner,setOwner]=useState('');
  const [source,setSource]=useState('');
  const [campaign,setCampaign]=useState('');
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [paymentOpen,setPaymentOpen]=useState(false);
  const [adsOpen,setAdsOpen]=useState(false);
  const workspaceReady=activeOrg?.orgId===props.organizationId;
  const query=new URLSearchParams({from,to,view});
  if(pipeline) query.set('pipeline_id',pipeline);
  if(owner) query.set(owner.startsWith('ai:')?'owner_agent_id':'owner_user_id',owner.slice(owner.indexOf(':')+1));
  if(source) query.set('source',source);
  if(campaign) {const [accountId,campaignId]=campaign.split(':');query.set('account_id',accountId!);query.set('campaign_id',campaignId!);}
  const settings=useQuery({queryKey:['dashboard-settings',props.organizationId],queryFn:()=>dashboardFetch<DashboardSettingsResponse>('/api/v1/metrics/dashboard/settings',undefined,props.organizationId),enabled:workspaceReady,refetchOnWindowFocus:false});
  const team=useQuery({queryKey:['dashboard-team',props.organizationId],queryFn:()=>dashboardFetch<Array<{user_id:string;full_name:string|null;email:string|null}>>('/api/v1/team',undefined,props.organizationId),
    enabled:workspaceReady&&props.canManage,staleTime:60_000});
  const result=useQuery({queryKey:['dashboard',props.organizationId,query.toString()],
    queryFn:({signal})=>dashboardFetch<DashboardData>(`/api/v1/metrics/dashboard?${query}`,{signal},props.organizationId),
    enabled:workspaceReady&&!!from&&!!to,staleTime:30_000});
  const data=result.data;
  const selectedPipeline=settings.data?.pipelines.find(p=>p.id===pipeline);
  const pipelineNames=new Map(settings.data?.pipelines.map(x=>[x.id,x.name])??[]);
  const stages=new Map(settings.data?.stages.map(s=>[s.id,!pipeline?`${pipelineNames.get(s.pipeline_id)??''} › ${s.name}`:s.name])??[]);
  const campaignOptions=settings.data?.campaigns??[];
  const quantityLabels=new Set(settings.data?.pipelines.filter(x=>!x.is_archived).map(x=>x.dashboard?.quantity_label??t('Unidades vendidas'))??[]);
  const quantityLabel=selectedPipeline?.dashboard?.quantity_label??(quantityLabels.size===1?[...quantityLabels][0]!:t('Unidades vendidas'));
  const ownerOptions=[...(team.data??[]).map(x=>({key:`user:${x.user_id}`,label:x.full_name??x.email??t('Atendente')})),
    ...(settings.data?.agents??[]).map(x=>({key:`ai:${x.id}`,label:x.name}))];
  const sourceOptions=[...new Set([...(data?.sources.map(s=>s.source)??[]),...(source?[source]:[])])];
  const selectClass='h-10 min-w-0 rounded-md border bg-background px-3 text-sm';
  return <div className="flex min-w-0 flex-col gap-6 p-4 md:p-6" data-testid="commercial-dashboard">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{t('Dashboard')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('Do primeiro contato ao pagamento confirmado, neste workspace.')}</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>result.refetch()} disabled={result.isFetching}>{t('Atualizar indicadores')}</Button>
        {props.canManage?<><Button variant="outline" onClick={()=>setSettingsOpen(true)}>{t('Configurar indicadores')}</Button>
          <Button onClick={()=>setPaymentOpen(true)}>{t('Registrar pagamento')}</Button></>:null}</div></header>
    <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-6">
      <div><Label htmlFor="dashboard-from">{t('De')}</Label><Input id="dashboard-from" type="date" value={from} onChange={e=>setFrom(e.target.value)} /></div>
      <div><Label htmlFor="dashboard-to">{t('Até')}</Label><Input id="dashboard-to" type="date" value={to} onChange={e=>setTo(e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label htmlFor="dashboard-view">{t('Visão')}</Label><select id="dashboard-view" className={selectClass} value={view} onChange={e=>setView(e.target.value as typeof view)}>
        <option value="acquisition">{t('Retorno da captação')}</option><option value="payments">{t('Pagamentos do período')}</option></select></div>
      <div className="flex flex-col gap-1"><Label htmlFor="dashboard-pipeline">{t('Funil')}</Label><select id="dashboard-pipeline" className={selectClass} value={pipeline} onChange={e=>setPipeline(e.target.value)}>
        <option value="">{t('Todos os funis')}</option>{settings.data?.pipelines.map(p=><option key={p.id} value={p.id}>{p.name}{p.is_archived?` (${t('arquivado')})`:''}</option>)}</select></div>
      {props.canManage?<div className="flex flex-col gap-1"><Label htmlFor="dashboard-campaign">{t('Campanha')}</Label><select id="dashboard-campaign" className={selectClass} value={campaign} onChange={e=>setCampaign(e.target.value)}>
        <option value="">{t('Todas as campanhas')}</option>{campaignOptions.map(c=><option key={`${c.account_id}:${c.campaign_id}`} value={`${c.account_id}:${c.campaign_id}`}>{c.campaign_name}</option>)}</select></div>:null}
      <div className="flex flex-col gap-1"><Label htmlFor="dashboard-source">{t('Origem')}</Label><select id="dashboard-source" className={selectClass} value={source} onChange={e=>setSource(e.target.value)}>
        <option value="">{t('Todas as origens')}</option>{sourceOptions.map(s=><option key={s} value={s}>{s||t('Não identificada')}</option>)}</select></div>
    </div>
    {props.canManage?<div className="flex flex-wrap items-center gap-3 text-sm"><Label htmlFor="dashboard-owner">{t('Responsável atual')}</Label><select id="dashboard-owner" className={selectClass} value={owner} onChange={e=>setOwner(e.target.value)}><option value="">{t('Todos os responsáveis')}</option>
      {ownerOptions.map(o=><option key={o.key} value={o.key}>{o.label}{o.key===`user:${props.currentUserId}`?` (${t('você')})`:''}</option>)}</select><span className="text-muted-foreground">{t('O filtro segue a atribuição atual do negócio.')}</span></div>:null}
    <p className="text-sm text-muted-foreground">{view==='acquisition'?t('Acompanha os leads recebidos no período e seus primeiros pagamentos posteriores, até a última atualização.'):t('Mostra os primeiros pagamentos recebidos no período, mesmo de leads captados antes.')}
      {data?` ${t('Fuso')}: ${data.timezone}. ${t('Atualizado em')}: ${new Date(data.as_of).toLocaleString('pt-BR',{timeZone:data.timezone})}.`:''}</p>
    {result.isPending||!workspaceReady?<p role="status">{t('Carregando indicadores…')}</p>:null}
    {result.error?<div role="alert" className="rounded-lg border border-destructive p-4">{result.error.message}</div>:null}
    {settings.error?<div role="alert">{settings.error.message}</div>:null}
    {data&&!result.error&&workspaceReady?<>
      {data.timezone_fallback?<p role="alert">{t('O fuso do workspace é inválido. Corrija em Configurações → Empresa.')}</p>:null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label={t('Leads recebidos')} value={data.leads} />
        <Metric label={t('Qualificados registrados')} value={data.qualified} note={data.qualification_incomplete?t('Histórico parcial: configure as etapas de qualificação.'):undefined}/>
        <Metric label={t('Vendas confirmadas')} value={data.sales} note={t('Uma venda por oportunidade com primeiro pagamento válido.')}/>
        <Metric label={quantityLabel} value={data.quantity} /></div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Metric label={t('Valor em negociação agora')} value={data.money.length?data.money.map(m=>money(m.pipeline_cents,m.currency)).join(' · '):'—'} note={data.pipeline_without_value?`${data.pipeline_without_value} ${t('negócios sem valor ou moeda completos.')}`:undefined}/>
        <Metric label={t('Primeiros pagamentos')} value={data.money.length?data.money.map(m=>money(m.revenue_cents,m.currency)).join(' · '):'—'} note={t('Sem projetar mensalidades futuras.')}/>
        {props.canManage?<Metric label={t('Gasto em anúncios')} value={data.money.length?data.money.map(m=>money(m.spend_cents,m.currency)).join(' · '):'—'} note={t('Dados sincronizados da Meta; ausência de dados não significa gasto zero.')}/>:<Metric label={t('Conversão da captação')} value={data.conversion_rate===null?'—':`${(data.conversion_rate*100).toFixed(1)}%`} />}
      </div>
      {data.won_without_payment?<p className="rounded-lg border p-3 text-sm">{data.won_without_payment} {t('negócios ganhos ainda não têm primeiro pagamento válido registrado. Eles não entram nas vendas confirmadas.')}</p>:null}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">{t('Carteira aberta por etapa')}</h2>
          {!data.stages.length?<p className="mt-3 text-sm text-muted-foreground">{t('Nenhum negócio aberto neste filtro.')}</p>:<div className="mt-4 space-y-3">{data.stages.map(s=><div key={s.stage_id}>
            <div className="mb-1 flex justify-between gap-3 text-sm"><span>{stages.get(s.stage_id)??t('Etapa não identificada')}</span><span>{s.count}</span></div>
            <div className="h-2 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${s.count/Math.max(1,...data.stages.map(x=>x.count))*100}%`}} /></div></div>)}</div>}
        </section>
        <section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">{t('Origem dos leads e das vendas')}</h2>
          <table className="mt-3 w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">{t('Origem')}</th><th>{t('Leads')}</th><th>{t('Vendas')}</th></tr></thead>
            <tbody>{data.sources.map(s=><tr key={s.source} className="border-b"><td className="py-2">{s.source||t('Não identificada')}</td><td>{s.leads}</td><td>{s.sales}</td></tr>)}</tbody></table>
          {!data.sources.length?<p className="mt-3 text-sm text-muted-foreground">{t('Sem registros no período.')}</p>:null}</section>
      </div>
      {props.canManage?<section className="rounded-xl border bg-card p-4"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{t('Campanhas e fechamentos')}</h2><Button variant="outline" onClick={()=>setAdsOpen(true)}>{t('Vincular e sincronizar campanhas')}</Button></div>
        {data.spend_incomplete?<p className="mt-3 text-sm text-muted-foreground">{t('Há campanhas sem consulta completa para o período. Sincronize os gastos antes de avaliar os custos.')}</p>:null}
        {data.timezone_mismatch?<p className="mt-3 text-sm text-muted-foreground">{t('Há contas de anúncios com fuso diferente do workspace. O gasto segue os dias da conta; custos comparativos ficam indisponíveis.')}</p>:null}
        {data.spend_not_comparable?<p className="mt-3 text-sm text-muted-foreground">{t('Retire os filtros de funil, responsável e origem para comparar o gasto total das campanhas com seus resultados.')}</p>:null}
        {view==='payments'?<p className="mt-3 text-sm text-muted-foreground">{t('Use Retorno da captação para calcular custos por lead e por fechamento com a mesma base de leads.')}</p>:null}
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-sm"><thead><tr className="border-b">
          {[t('Campanha'),t('Gasto'),t('Leads'),t('Qualificados'),t('Vendas'),t('Primeiros pagamentos'),t('Custo por lead'),t('Custo por qualificado'),t('Custo por venda'),t('Retorno')].map(h=><th key={h} className="p-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{data.campaigns.map((c,i)=><tr key={`${c.account_id}:${c.campaign_id}:${c.currency}:${i}`} className="border-b"><td className="p-2">{c.label}{c.currency_conflict?<span className="block text-xs text-muted-foreground">{t('Moedas diferentes; comparação indisponível.')}</span>:null}
            {c.oldest_sync_at?<span className="block text-xs text-muted-foreground">{t('Consulta mais antiga do período')}: {new Date(c.oldest_sync_at).toLocaleString('pt-BR',{timeZone:data.timezone})}</span>:null}</td>
            <td className="p-2">{money(c.spend_cents,c.currency)}</td><td>{c.leads}</td><td>{c.qualified}{!c.qualification_complete?'*':''}</td><td>{c.sales}</td><td>{money(c.revenue_cents,c.currency)}</td>
            <td>{money(c.cpl_cents,c.currency)}</td><td>{money(c.cplq_cents,c.currency)}</td><td>{money(c.cost_per_sale_cents,c.currency)}</td><td>{c.roas===null?'—':`${c.roas.toFixed(2)}×`}</td></tr>)}</tbody></table></div>
        {!data.campaigns.length?<p className="mt-3 text-sm text-muted-foreground">{t('Vincule campanhas e sincronize os dados para acompanhar seus resultados.')}</p>:null}
      </section>:null}
      <Link className="text-sm underline" href="/app/metrics">{t('Ver métricas detalhadas de atendimento')}</Link>
      {props.canManage?<section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">{t('Resultados por responsável atual')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('Representa a carteira atual. Uma troca de responsável altera essa distribuição.')}</p>
        <table className="mt-3 w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">{t('Responsável')}</th><th>{t('Leads')}</th><th>{t('Vendas')}</th></tr></thead>
          <tbody>{data.owners.map(o=><tr key={`${o.owner_kind}:${o.owner_id}`} className="border-b"><td className="py-2">{ownerOptions.find(x=>x.key===`${o.owner_kind==='ai'?'ai':'user'}:${o.owner_id}`)?.label??t('Sem responsável identificado')}</td><td>{o.leads}</td><td>{o.sales}</td></tr>)}</tbody></table>
        {team.error?<p role="alert" className="mt-2 text-sm">{team.error.message}</p>:null}</section>:null}
    </>:null}
    {props.canManage&&settings.data?<><DashboardSettingsDialog key={props.organizationId} open={settingsOpen} onOpenChange={setSettingsOpen}
      organizationId={props.organizationId} settings={settings.data} initialPipeline={pipeline}/>
      <PaymentDialog open={paymentOpen} onOpenChange={setPaymentOpen} organizationId={props.organizationId} pipelineId={pipeline}/></>:null}
    {props.canManage&&settings.data?<DashboardAdsDialog open={adsOpen} onOpenChange={setAdsOpen} organizationId={props.organizationId} settings={settings.data} from={from} to={to}/>:null}
  </div>;
}
