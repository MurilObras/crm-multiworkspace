'use client';
import { useEffect,useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/hooks/i18n/useT';
import { dashboardFetch } from '@/lib/dashboard/client';
import type { DashboardSettingsResponse } from '@/lib/dashboard/contracts';

export function DashboardSettingsDialog(p:{open:boolean;onOpenChange:(value:boolean)=>void;organizationId:string;settings:DashboardSettingsResponse;initialPipeline:string}) {
  const t=useT();const qc=useQueryClient();
  const [pipeline,setPipeline]=useState('');const [stages,setStages]=useState<string[]>([]);
  const [label,setLabel]=useState('Unidades vendidas');const [conversions,setConversions]=useState(true);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{if(p.open){setPipeline(p.initialPipeline||p.settings.pipelines.find(x=>!x.is_archived)?.id||'');setError('');
    setConversions(p.settings.conversions_configured?p.settings.confirmed_payment_conversions:true);}},[p.open,p.initialPipeline,p.settings]);
  useEffect(()=>{
    const config=p.settings.pipelines.find(x=>x.id===pipeline)?.dashboard;
    const active=new Set(p.settings.stages.filter(s=>s.pipeline_id===pipeline&&!s.is_archived).map(s=>s.id));
    setStages((config?.qualified_stage_ids??[]).filter(id=>active.has(id)));setLabel(config?.quantity_label??'Unidades vendidas');
  },[pipeline,p.settings]);
  const save=async()=>{
    setBusy(true);setError('');
    try{await dashboardFetch('/api/v1/metrics/dashboard/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      pipeline_id:pipeline,qualified_stage_ids:stages,quantity_label:label,confirmed_payment_conversions:conversions,
    })},p.organizationId);await Promise.all([qc.invalidateQueries({queryKey:['dashboard-settings',p.organizationId]}),qc.invalidateQueries({queryKey:['dashboard',p.organizationId]})]);p.onOpenChange(false);
    }catch(e){setError(e instanceof Error?e.message:t('Não foi possível salvar.'));}finally{setBusy(false);}
  };
  return <Dialog open={p.open} onOpenChange={value=>{if(!busy)p.onOpenChange(value);}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{t('Configurar indicadores')}</DialogTitle><DialogDescription>{t('As regras valem somente para este workspace. A qualificação conta uma vez por oportunidade, ao entrar em uma etapa selecionada.')}</DialogDescription></DialogHeader>
    <div className="space-y-2"><Label htmlFor="metric-pipeline">{t('Funil')}</Label><select id="metric-pipeline" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={pipeline} onChange={e=>setPipeline(e.target.value)}>
      <option value="">{t('Selecione um funil')}</option>{p.settings.pipelines.filter(x=>!x.is_archived).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
    <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('Etapas que representam um lead qualificado')}</legend>
      {p.settings.stages.filter(s=>s.pipeline_id===pipeline&&!s.is_archived).map(s=><label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stages.includes(s.id)}
        onChange={e=>setStages(old=>e.target.checked?[...old,s.id]:old.filter(id=>id!==s.id))}/>{s.name}</label>)}</fieldset>
    <p className="text-xs text-muted-foreground">{t('Vale para novos avanços. O histórico anterior não é presumido, e qualificações já registradas são preservadas.')}</p>
    <div><Label htmlFor="metric-quantity">{t('Nome da quantidade vendida')}</Label><Input id="metric-quantity" maxLength={50} value={label} onChange={e=>setLabel(e.target.value)} placeholder={t('Matrículas, assinaturas, unidades…')}/></div>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={conversions} onChange={e=>setConversions(e.target.checked)}/>
      <span>{t('Reportar conversão aos anúncios somente com primeiro pagamento confirmado.')}</span></label>
    <p className="text-xs text-muted-foreground">{t('A conexão de conversões precisa estar habilitada separadamente. Desligar esta regra preserva o modo anterior, baseado em negócio ganho.')}</p>
    {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
    <Button disabled={busy||!pipeline||!label.trim()} onClick={save}>{busy?t('Salvando…'):t('Salvar configurações')}</Button>
  </DialogContent></Dialog>;
}
