'use client';
import { useEffect,useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/hooks/i18n/useT';
import { dashboardFetch,dashboardMoney } from '@/lib/dashboard/client';

interface Payment {id:string;lead_id:string;amount_cents:number;currency:string;paid_at:string;quantity:number;source:string;note:string;updated_at:string;voided_at:string|null}
function localDateTime(iso:string) {
  const at=new Date(iso);return new Date(at.getTime()-at.getTimezoneOffset()*60_000).toISOString().slice(0,16);
}
export function PaymentDialog(p:{open:boolean;onOpenChange:(value:boolean)=>void;organizationId:string;pipelineId:string}) {
  const t=useT();const qc=useQueryClient();
  const [search,setSearch]=useState('');const [lead,setLead]=useState('');
  const [amount,setAmount]=useState('');const [currency,setCurrency]=useState('BRL');
  const [paidAt,setPaidAt]=useState(()=>localDateTime(new Date().toISOString()));
  const [quantity,setQuantity]=useState('1');const [note,setNote]=useState('');
  const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selectedTitle,setSelectedTitle]=useState('');
  const leadsQuery=new URLSearchParams({search});if(p.pipelineId) leadsQuery.set('pipeline_id',p.pipelineId);
  const leads=useQuery({queryKey:['dashboard-payment-leads',p.organizationId,leadsQuery.toString()],
    queryFn:({signal})=>dashboardFetch<Array<{id:string;title:string}>>(`/api/v1/metrics/dashboard/leads?${leadsQuery}`,{signal},p.organizationId),enabled:p.open});
  const current=useQuery({queryKey:['dashboard-payment',p.organizationId,lead],
    queryFn:()=>dashboardFetch<Payment|null>(`/api/v1/leads/${lead}/first-payment`,undefined,p.organizationId),enabled:p.open&&!!lead,refetchOnWindowFocus:false});
  useEffect(()=>{
    if(!p.open){setLead('');setSearch('');setError('');setNotice('');setConfirmed(false);}
  },[p.open]);
  useEffect(()=>{setNotice('');},[lead]);
  useEffect(()=>{
    setConfirmed(false);setError('');
    const payment=current.data;
    setAmount(payment?(payment.amount_cents/100).toFixed(2):'');setCurrency(payment?.currency??'BRL');
    setPaidAt(localDateTime(payment?.paid_at??new Date().toISOString()));setQuantity(String(payment?.quantity??1));setNote(payment?.note??'');
  },[lead,current.data]);
  const save=async(mode:'save'|'void')=>{
    if(!lead)return;setError('');setBusy(true);
    try {
      if(mode==='save'&&!confirmed) throw new Error(t('Confirme que o pagamento foi efetivamente recebido.'));
      const payment=current.data;
      const body=mode==='void'?{reason:note,expected_updated_at:payment?.updated_at}:{
        amount_cents:Math.round(Number(amount)*100),currency,paid_at:new Date(paidAt).toISOString(),quantity:Number(quantity),note,
        ...(payment?{expected_updated_at:payment.updated_at}:{}),
      };
      const result=await dashboardFetch<{funnel_closed?:boolean}>(`/api/v1/leads/${lead}/first-payment`,{
        method:mode==='void'?'DELETE':payment?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      },p.organizationId);
      await Promise.all([qc.invalidateQueries({queryKey:['dashboard',p.organizationId]}),qc.invalidateQueries({queryKey:['dashboard-payment',p.organizationId,lead]})]);
      if(result.funnel_closed===false&&mode==='save'){setNotice(t('Pagamento registrado. O funil não tem etapa de ganho configurada; confira a movimentação do negócio.'));return;}
      p.onOpenChange(false);
    }catch(e){setError(e instanceof Error?e.message:t('Não foi possível salvar.'));}finally{setBusy(false);}
  };
  return <Dialog open={p.open} onOpenChange={value=>{if(!busy)p.onOpenChange(value);}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{t('Primeiro pagamento confirmado')}</DialogTitle><DialogDescription>{t('Registre somente o valor efetivamente recebido. Comprovante enviado pelo cliente não confirma o recebimento automaticamente.')}</DialogDescription></DialogHeader>
    <div className="space-y-2"><Label htmlFor="payment-search">{t('Buscar negócio')}</Label><Input id="payment-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('Nome do negócio ou responsável')}/>
      <Label htmlFor="payment-lead">{t('Negócio')}</Label><select id="payment-lead" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={lead} disabled={busy} onChange={e=>{setLead(e.target.value);setSelectedTitle(leads.data?.find(l=>l.id===e.target.value)?.title??'');}}>
        <option value="">{t('Selecione o negócio')}</option>{lead&&!leads.data?.some(l=>l.id===lead)?<option value={lead}>{selectedTitle}</option>:null}
        {leads.data?.map(l=><option key={l.id} value={l.id}>{l.title}</option>)}</select>
      <p className="text-xs text-muted-foreground">{t('Até 50 resultados; refine a busca quando necessário.')}</p></div>
    {leads.error?<p role="alert">{leads.error.message}</p>:null}
    {current.error?<div role="alert">{current.error.message}<Button variant="outline" onClick={()=>current.refetch()}>{t('Tentar novamente')}</Button></div>:null}
    {current.isFetching&&lead?<p role="status">{t('Consultando pagamento…')}</p>:null}
    {lead&&!current.isFetching&&!current.error?<form className="space-y-3" onSubmit={e=>{e.preventDefault();void save('save');}}>
      {current.data?<p className="rounded-md bg-muted p-3 text-sm">{current.data.voided_at?t('Registro invalidado. Salvar uma correção o torna válido novamente.'):t('Já existe um primeiro pagamento. A alteração será registrada no histórico.')}
        {' '}{dashboardMoney(current.data.amount_cents,current.data.currency)}</p>:null}
      <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="payment-amount">{t('Valor recebido')}</Label><Input id="payment-amount" required type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></div>
        <div><Label htmlFor="payment-currency">{t('Moeda')}</Label><Input id="payment-currency" required maxLength={3} pattern="[A-Z]{3}" value={currency} onChange={e=>setCurrency(e.target.value.toUpperCase())}/></div></div>
      <div><Label htmlFor="payment-date">{t('Data e hora do pagamento')}</Label><Input id="payment-date" required type="datetime-local" value={paidAt} onChange={e=>setPaidAt(e.target.value)}/>
        <p className="mt-1 text-xs text-muted-foreground">{t('Horário deste computador; o dashboard apresenta o período no fuso do workspace.')}</p></div>
      <div><Label htmlFor="payment-quantity">{t('Quantidade vendida')}</Label><Input id="payment-quantity" required type="number" min="1" max="10000" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/>
        <p className="mt-1 text-xs text-muted-foreground">{t('Duas unidades no mesmo pagamento: quantidade 2. Continua sendo uma venda.')}</p></div>
      <div><Label htmlFor="payment-note">{t('Observação ou motivo da correção')}</Label><Input id="payment-note" maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t('Conferi e confirmo o recebimento deste valor.')}</label>
      <p className="text-xs text-muted-foreground">{t('Correções atualizam o dashboard. Conversões já reportadas aos anúncios não são enviadas outra vez.')}</p>
      <div className="flex flex-wrap justify-end gap-2">{current.data&&!current.data.voided_at?<Button type="button" variant="outline" disabled={busy||note.trim().length<3} onClick={()=>save('void')}>{t('Invalidar registro')}</Button>:null}
        <Button type="submit" disabled={busy||!confirmed}>{busy?t('Salvando…'):current.data?t('Salvar correção'):t('Confirmar pagamento')}</Button></div>
    </form>:null}{notice?<p role="status" className="text-sm">{notice}</p>:null}
    {error?<div role="alert" className="text-sm text-destructive">{error}{lead?<Button variant="outline" disabled={busy} onClick={()=>current.refetch()}>{t('Recarregar registro')}</Button>:null}</div>:null}
  </DialogContent></Dialog>;
}
