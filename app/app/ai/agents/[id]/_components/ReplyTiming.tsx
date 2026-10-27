"use client";
import { useEffect, useState, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { readReplyDelay, replyDelaySchema, REPLY_DELAY_DEFAULT } from '@/lib/ai/agents/reply-delay';
import { useT } from '@/hooks/i18n/useT';
export function ReplyTiming(props: {agentId:string;readOnly:boolean}) {return <TimingForm key={props.agentId} {...props}/>;}
function TimingForm({agentId,readOnly}:{agentId:string;readOnly:boolean}) {
 const t=useT(),id=useId();const [value,setValue]=useState(REPLY_DELAY_DEFAULT),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[feedback,setFeedback]=useState('');
 useEffect(()=>{const abort=new AbortController();void fetch('/api/v1/ai/agents/'+agentId,{cache:'no-store',signal:abort.signal}).then(async r=>{if(!r.ok)throw Error(t('Falha ao carregar o tempo de resposta.'));const j=await r.json();if(!abort.signal.aborted){setValue(readReplyDelay(j.data?.config));setLoaded(true);}}).catch(()=>{if(!abort.signal.aborted)setFeedback(t('Não foi possível carregar. Recarregue a página.'));});return()=>abort.abort();},[agentId,t]);
 async function save(){const valid=replyDelaySchema.safeParse(value);if(!valid.success){setFeedback(t('Informe tempos válidos, com máximo maior ou igual ao mínimo.'));return;}setBusy(true);setFeedback('');try{const r=await fetch('/api/v1/ai/agents/'+agentId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:{reply_delay:valid.data}})});if(!r.ok)throw Error();const check=await fetch('/api/v1/ai/agents/'+agentId,{cache:'no-store'});const j=await check.json();if(!check.ok||JSON.stringify(readReplyDelay(j.data?.config))!==JSON.stringify(valid.data))throw Error();setFeedback(t('Tempo de resposta salvo e conferido. Vale para os próximos atendimentos do agente publicado.'));}catch{setFeedback(t('Não foi possível confirmar o salvamento. Recarregue e tente novamente.'));}finally{setBusy(false);}}
 const disabled=!loaded||busy||readOnly;
 return <section className="space-y-3 rounded-md border p-4" aria-label={t('Tempo mínimo de resposta')}>
 <div className="flex items-center gap-2"><Switch id={id} checked={value.enabled} disabled={disabled} onCheckedChange={enabled=>setValue({...value,enabled})}/><Label htmlFor={id}>{t('Ativar tempo mínimo antes da primeira resposta')}</Label></div>
 <p className="text-xs text-muted-foreground">{t('Conta desde a última mensagem do cliente, incluindo o processamento. Se a resposta já demorou, não soma outra espera. As partes seguintes continuam com intervalo curto. Padrão: desligado.')}</p>
 <Label htmlFor={id+'min'}>{t('Mínimo em segundos')}</Label><Input id={id+'min'} type="number" min={0} max={600} disabled={disabled} value={value.min_seconds} onChange={e=>setValue({...value,min_seconds:Number(e.target.value)})}/>
 <Label htmlFor={id+'max'}>{t('Máximo em segundos')}</Label><Input id={id+'max'} type="number" min={0} max={600} disabled={disabled} value={value.max_seconds} onChange={e=>setValue({...value,max_seconds:Number(e.target.value)})}/>
 <Button type="button" disabled={disabled} onClick={()=>void save()}>{t('Salvar tempo de resposta')}</Button><p role="status" className="text-xs">{feedback}</p>
 </section>;
}
