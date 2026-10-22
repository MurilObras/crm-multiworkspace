"use client";
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_CONSULTATION, type ConsultationSettings } from "@/lib/responsibles/config";
import type { Responsible } from "@/lib/responsibles/service";
import { useT } from "@/hooks/i18n/useT";

export function ResponsibleConsultation({ agentId, disabled = false }: { agentId: string; disabled?: boolean }) {
  const t = useT();
  const [settings, setSettings] = React.useState<ConsultationSettings>(DEFAULT_CONSULTATION);
  const [recipients, setRecipients] = React.useState<Responsible[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [editing, setEditing] = React.useState<string | undefined>();
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [recipientEnabled, setRecipientEnabled] = React.useState(true);
  const url = `/api/v1/ai/agents/${agentId}/responsibles`;
  const load = React.useCallback(async (overwriteSettings = true) => {
    const response = await fetch(url);
    const json = await response.json();
    if (!response.ok) throw new Error(json.error?.message ?? "Falha ao carregar responsáveis.");
    if (overwriteSettings) setSettings(json.data.settings);
    setRecipients(json.data.recipients); setLoaded(true); return json.data as { settings: ConsultationSettings; recipients: Responsible[] };
  }, [url]);
  React.useEffect(() => { let mounted = true; setLoading(true);
    load().catch(() => { if (mounted) setError("Não foi possível carregar esta configuração."); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [load]);
  async function save(kind: "settings" | "recipient") {
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = kind === "settings" ? settings : { id: editing, name, phone, enabled: recipientEnabled };
      const response = await fetch(url, { method: kind === "settings" ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error?.message ?? "Falha ao salvar.");
      const checked = await load(kind === "settings");
      if (kind === "settings" && (checked.settings.enabled !== settings.enabled || checked.settings.conditions !== settings.conditions.trim() ||
        [...checked.settings.recipient_ids].sort().join(",") !== [...new Set(settings.recipient_ids)].sort().join(","))) throw new Error("A configuração mudou durante a gravação. Confira os valores carregados antes de salvar novamente.");
      if (kind === "recipient") { setName(""); setPhone(""); setEditing(undefined); setRecipientEnabled(true); }
      setNotice(kind === "settings" ? "Configuração salva e conferida. Vale para os próximos atendimentos deste agente publicado." : "Responsável salvo neste workspace. Selecione-o abaixo e salve a configuração do agente.");
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar."); } finally { setBusy(false); }
  }
  const locked = disabled || !loaded || loading || busy;
  return <Card className="space-y-4 p-4" data-testid="responsible-consultation">
    <h3 className="text-sm font-medium">{t("Consultar responsável pelo WhatsApp")}</h3>
    <p className="text-xs text-muted-foreground">{t("Usa o número por QR Code do atendimento. Quando precisa de confirmação, avisa o cliente e pausa a conversa e os follow-ups até a resposta. Um pedido para falar com uma pessoa mantém o atendimento humano.")}</p>
    {loading && <p>{t("Carregando configuração…")}</p>}
    <div className="flex items-center gap-2"><Switch id="responsible-consultation-enabled" checked={settings.enabled} disabled={locked}
      onCheckedChange={enabled => setSettings(s => ({ ...s, enabled }))} /><Label htmlFor="responsible-consultation-enabled">{t("Ativar consulta e avisos aos responsáveis")}</Label></div>
    <fieldset disabled={locked} className="space-y-2"><legend className="text-sm">{t("Quem recebe os avisos deste agente")}</legend>
      {!recipients.length && <p className="text-xs">{t("Cadastre um responsável abaixo para começar.")}</p>}
      {recipients.map(r => <div key={r.id} className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" disabled={!r.enabled && !settings.recipient_ids.includes(r.id)}
          checked={settings.recipient_ids.includes(r.id)} onChange={e => setSettings(s => ({ ...s, recipient_ids: e.target.checked ? [...s.recipient_ids, r.id] : s.recipient_ids.filter(id => id !== r.id) }))} />
          <span className="break-all">{r.name} · {r.phone}{!r.enabled ? ` (${t("desativado")})` : ""}</span></label>
        <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(r.id); setName(r.name); setPhone(r.phone); setRecipientEnabled(r.enabled); }}>{t("Editar responsável")}</Button>
      </div>)}
    </fieldset>
    <div className="space-y-2"><Label htmlFor="responsible-conditions">{t("Situações que exigem confirmação")}</Label>
      <Textarea id="responsible-conditions" value={settings.conditions} maxLength={4000} disabled={locked}
        placeholder={t("Ex.: condições especiais, descontos não autorizados ou dúvidas sem resposta na base aprovada.")}
        onChange={e => setSettings(s => ({ ...s, conditions: e.target.value }))} /></div>
    <p className="text-xs text-muted-foreground">{t("No WhatsApp, use Responder sobre o aviso. O texto é repassado sem reescrita; o áudio é entregue como foi gravado. Nesta opção, escreva ou grave a resposta para o cliente, sem instruções internas.")}</p>
    <p className="text-xs text-muted-foreground">{t("Os números cadastrados são de uso interno neste workspace. Use um número diferente do cliente de teste e do WhatsApp conectado ao CRM.")}</p>
    <Button type="button" disabled={locked} onClick={() => save("settings")}>{t("Salvar consulta ao responsável")}</Button>
    <fieldset disabled={locked} className="space-y-2 rounded-md border p-3"><legend className="px-1 text-sm">{t(editing ? "Editar responsável do workspace" : "Cadastrar responsável do workspace")}</legend>
      <Label htmlFor="responsible-name">{t("Nome do responsável")}</Label><Input id="responsible-name" value={name} maxLength={100} onChange={e => setName(e.target.value)} />
      <Label htmlFor="responsible-phone">{t("WhatsApp com código do país")}</Label><Input id="responsible-phone" value={phone} type="tel" placeholder="+5511999999999" onChange={e => setPhone(e.target.value)} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recipientEnabled} onChange={e => setRecipientEnabled(e.target.checked)} />{t("Responsável ativo")}</label>
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={!name.trim() || !phone.trim()} onClick={() => save("recipient")}>{t("Salvar responsável")}</Button>
        {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(undefined); setName(""); setPhone(""); setRecipientEnabled(true); }}>{t("Cancelar edição")}</Button>}</div>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
    {!loaded && !loading && <Button type="button" variant="outline" onClick={async () => { setLoading(true); setError(""); try { await load(); } catch { setError("Não foi possível carregar esta configuração."); } finally { setLoading(false); } }}>{t("Carregar novamente")}</Button>}
    {notice && <p role="status" className="text-sm">{t(notice)}</p>}
  </Card>;
}
