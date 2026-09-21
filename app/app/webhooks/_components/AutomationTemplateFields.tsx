"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TemplatesPayload } from "@/hooks/channels/useTemplates";
import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from "@/components/ui/select";

interface Config {
  channel_session_id: string; template_name?: string; template_language?: string;
  template_values?: Record<string,string>;
}
export function AutomationTemplateFields({config,onChange}:{config:Config;onChange:(config:Config)=>void}) {
  const t=useT();
  const query=useQuery({queryKey:["automation-approved-templates",config.channel_session_id],enabled:!!config.channel_session_id,
    queryFn:()=>apiClient.get<{data:TemplatesPayload}>(`/api/v1/channels/templates?channel_session_id=${encodeURIComponent(config.channel_session_id)}`)});
  const templates=query.data?.data.templates ?? [];
  const selected=templates.find(row=>row.name===config.template_name && row.language===config.template_language);
  return <div className="space-y-2">
    <Label>{t("Template aprovado")}</Label>
    <Select value={selected ? `${selected.name}:${selected.language}` : ""} onValueChange={value=>{
      const row=templates.find(item=>`${item.name}:${item.language}`===value);
      if(row) onChange({channel_session_id:config.channel_session_id,template_name:row.name,template_language:row.language,template_values:{}});
    }} disabled={!config.channel_session_id || query.isPending || query.isError}>
      <SelectTrigger><SelectValue placeholder={t("Escolha um template aprovado")} /></SelectTrigger>
      <SelectContent>{templates.map(row=><SelectItem key={`${row.name}:${row.language}`} value={`${row.name}:${row.language}`}>{row.name} ({row.language})</SelectItem>)}</SelectContent>
    </Select>
    {query.isError ? <p role="alert">{t("Não foi possível consultar os templates deste canal.")}</p>
      : !query.isPending && !templates.length ? <p>{t("Nenhum template aprovado disponível neste canal. Confira os modelos em Conexões.")}</p> : null}
    {selected?.slots.map(slot=><label className="block space-y-1 text-sm" key={slot.value_key ?? slot.key}>
      <span>{slot.onde} — {slot.key}</span>
      <Input value={config.template_values?.[slot.value_key ?? slot.key] ?? ""} onChange={event=>onChange({...config,
        template_values:{...config.template_values,[slot.value_key ?? slot.key]:event.target.value}})} />
    </label>)}
    <p className="text-xs text-muted-foreground">{t("Preencha os parâmetros obrigatórios. Você pode usar {{nome}} nos valores de texto.")}</p>
  </div>;
}
