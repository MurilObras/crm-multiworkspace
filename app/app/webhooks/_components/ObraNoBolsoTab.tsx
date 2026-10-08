"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_ACTIVATION_MESSAGE, DEFAULT_REGISTRATION_MESSAGE, DEFAULT_USAGE_MESSAGE } from "@/lib/obra-no-bolso/messages";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

type Receipt = {
  id: string; external_event_id: string; product_user_id: string; occurred_at: string;
  name: string | null; email: string | null; phone: string | null; plan: string; modality: "trial" | "paid";
  provider: string | null; status: string; reason: string | null;
  contact_id: string | null; lead_id: string | null; duplicate_count: number; created_at: string;
};
type State = {
  integration: { id: string; pipeline_id: string; is_active: boolean; lifecycle_enabled: boolean; last_received_at: string | null } | null;
  subscriptions?: Array<{ id: string; lead_id: string | null; trial_started_at: string; checked_at: string;
    status_pagamento: string; em_trial: boolean; decision: string; reason: string | null;
    contact?: { name: string | null } | null; lead?: { title: string } | null }>;
  subscription_pagination?: { offset: number; has_more: boolean };
  outreach?: { enabled: boolean; channel_session_id: string | null; recovery_pointer_id: string | null;
    registration_message: string; usage_message: string; activation_message: string };
  receipts: Receipt[];
  rejections: Array<{ created_at: string; reason: string }>;
  counts: { processed: number; trial: number; paid: number; pending: number; rejected: number; duplicates: number };
  pagination: { offset: number; has_more: boolean };
};
type Contact = { id: string; name: string | null; email: string | null; phone_number: string | null };
type Lead = { id: string; title: string };
const root = "/api/v1/integrations/obra-no-bolso";
const reasons: Record<string, string> = {
  invalid_phone: "Telefone inválido",
  contact_not_found: "Contato não encontrado",
  multiple_contacts: "Mais de um contato possível",
  contact_identity_conflict: "Telefone e e-mail apontam para contatos diferentes",
  contact_identity_changed: "Contato da oportunidade mudou ou ficou indisponível",
  open_lead_not_found: "Oportunidade aberta não encontrada no funil",
  multiple_open_leads: "Mais de uma oportunidade aberta",
  crm_identity_already_linked: "Contato ou oportunidade já vinculados",
  lead_no_longer_open: "Oportunidade deixou de estar aberta",
  won_stage_unavailable: "Etapa ganha Acesso ativado indisponível",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? "Operação indisponível.");
  return body.data as T;
}

export function ObraNoBolsoTab() {
  const t = useT();
  const idioma = useTagDeIdioma();
  const [state, setState] = React.useState<State | null>(null);
  const [funis, setFunis] = React.useState<Array<{ id: string; name: string }>>([]);
  const [pipelineId, setPipelineId] = React.useState("");
  const [lifecycle, setLifecycle] = React.useState(false);
  const [outreach, setOutreach] = React.useState<NonNullable<State["outreach"]>>({ enabled: false,
    channel_session_id: null, recovery_pointer_id: null, registration_message: DEFAULT_REGISTRATION_MESSAGE,
    usage_message: DEFAULT_USAGE_MESSAGE, activation_message: DEFAULT_ACTIVATION_MESSAGE });
  const [channels, setChannels] = React.useState<Array<{ id: string; display_name: string }>>([]);
  const [flows, setFlows] = React.useState<Array<{ id: string; name: string; status: string }>>([]);
  const [secretOnce, setSecretOnce] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<Receipt | null>(null);
  const [search, setSearch] = React.useState("");
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [contactId, setContactId] = React.useState("");
  const [leads, setLeads] = React.useState<Lead[]>([]);
  const [leadId, setLeadId] = React.useState("");
  const [historyOffset, setHistoryOffset] = React.useState(0);
  const [historyStatus, setHistoryStatus] = React.useState("all");
  const historyUrl = `${root}?offset=${historyOffset}&status=${historyStatus}`;

  const refresh = React.useCallback(async () => {
    try {
      const next = await api<State>(historyUrl);
      setState(next);
      if (next.outreach) setOutreach(next.outreach);
      if (next.integration) { setPipelineId(next.integration.pipeline_id); setLifecycle(next.integration.lifecycle_enabled); }
    } catch (error) { toast.error((error as Error).message); }
  }, [historyUrl]);
  React.useEffect(() => {
    let cancelled = false;
    void api<State>(historyUrl).then(next => {
      if (cancelled) return;
      setState(next);
      if (next.outreach) setOutreach(next.outreach);
      if (next.integration) { setPipelineId(next.integration.pipeline_id); setLifecycle(next.integration.lifecycle_enabled); }
    }).catch((error: Error) => toast.error(error.message));
    void api<Array<{ id: string; name: string }>>("/api/v1/pipelines")
      .then(setFunis).catch(() => toast.error(t("Funis indisponíveis.")));
    void api<Array<{ id: string; display_name: string }>>("/api/v1/channel-sessions")
      .then(setChannels).catch(() => toast.error(t("Números indisponíveis.")));
    void api<Array<{ id: string; name: string; status: string }>>("/api/v1/ai/followup-flows")
      .then(setFlows).catch(() => toast.error(t("Fluxos indisponíveis.")));
    return () => { cancelled = true; };
  }, [t, historyUrl]);

  const create = async () => {
    if (!pipelineId) return;
    setBusy(true);
    try {
      const created = await api<{ signing_secret: string }>(root, {
        method: "POST", body: JSON.stringify({ pipeline_id: pipelineId, lifecycle_enabled: lifecycle }),
      });
      setSecretOnce(created.signing_secret);
      toast.success(t("Integração criada desligada. Guarde o segredo agora."));
      await refresh();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };

  const toggle = async () => {
    if (!state?.integration) return;
    setBusy(true);
    try {
      await api(root, { method: "PATCH", body: JSON.stringify({ is_active: !state.integration.is_active }) });
      await refresh();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };

  const savePipeline = async () => {
    if (!state?.integration || !pipelineId || state.integration.is_active) return;
    setBusy(true);
    try {
      await api(root, { method: "PATCH", body: JSON.stringify({ pipeline_id: pipelineId, lifecycle_enabled: lifecycle }) });
      toast.success(t("Funil da integração atualizado."));
      await refresh();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };

  const findContacts = async () => {
    if (!pending || search.trim().length < 2) return;
    try {
      const found = await api<{ contacts: Contact[] }>(`${root}/options?receipt_id=${pending.id}&search=${encodeURIComponent(search.trim())}`);
      setContacts(found.contacts);
    } catch (error) { toast.error((error as Error).message); }
  };

  const chooseContact = async (id: string) => {
    if (!pending) return;
    setContactId(id); setLeadId("");
    try {
      const found = await api<{ leads: Lead[] }>(`${root}/options?receipt_id=${pending.id}&contact_id=${id}`);
      setLeads(found.leads);
    } catch (error) { toast.error((error as Error).message); }
  };

  const associate = async () => {
    if (!pending || !contactId || !leadId) return;
    setBusy(true);
    try {
      const result = await api<{ status: string }>(`${root}/receipts/${pending.id}/associate`, {
        method: "POST", body: JSON.stringify({ contact_id: contactId, lead_id: leadId }),
      });
      if (result.status === "processed") toast.success(t("Acesso confirmado e oportunidade encerrada."));
      else toast.info(t("Associação salva; confira o estado da conversão no histórico."));
      setPending(null); await refresh();
    } catch (error) { toast.error((error as Error).message); await refresh(); }
    finally { setBusy(false); }
  };

  const retry = async (id: string) => {
    setBusy(true);
    try {
      const result = await api<{ status: string }>(`${root}/receipts/${id}/retry`, { method: "POST" });
      toast.success(result.status === "processed" ? t("Conversão confirmada.") : t("Recebimento continua em processamento."));
      await refresh();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const saveMessages = async () => {
    setBusy(true);
    try {
      await api(root, { method: "PATCH", body: JSON.stringify({ outreach }) });
      toast.success(t("Mensagens do ciclo salvas.")); await refresh();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const refreshSubscription = async (id: string) => {
    setBusy(true);
    try {
      await api(`${root}/subscriptions/${id}/refresh`, { method: "POST" });
      toast.success(t("Estado consultado no aplicativo.")); await refresh();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };

  if (!state) return <p className="pt-4 text-sm text-muted-foreground">{t("Carregando integração…")}</p>;
  const integration = state.integration;
  return (
    <div className="space-y-6 pt-4">
      <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-lg font-semibold">Obra no Bolso</h2>
        <p className="text-sm text-muted-foreground">{t("O aplicativo informa o estado da assinatura. A conexão vale somente para este workspace.")}</p>
        <Label htmlFor="obra-lifecycle-mode">{t("Modo da conexão")}</Label>
        <Select value={lifecycle ? "lifecycle" : "legacy"} onValueChange={value => setLifecycle(value === "lifecycle")}
          disabled={busy || Boolean(integration?.is_active)}>
          <SelectTrigger id="obra-lifecycle-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="legacy">{t("Primeiro acesso (legado)")}</SelectItem>
            <SelectItem value="lifecycle">{t("Teste e assinatura após 96 horas")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("No modo teste e assinatura, o teste permanece aberto. Somente a confirmação de assinatura após 96 horas pode concluir a venda.")}</p>
        {!integration ? (
          <div className="space-y-2">
            <Label>{t("Funil de assinaturas")}</Label>
            <Select value={pipelineId} onValueChange={setPipelineId}>
              <SelectTrigger><SelectValue placeholder={t("Selecione o funil")} /></SelectTrigger>
              <SelectContent>{funis.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("O funil precisa de uma única etapa ganha chamada “Acesso ativado”.")}</p>
            <Button onClick={create} disabled={!pipelineId || busy}>{t("Criar integração desligada")}</Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p>{t("Estado")}: <strong>{integration.is_active ? t("Ativa") : t("Inativa")}</strong></p>
            <Label>{t("Funil de destino")}</Label>
            <div className="flex gap-2">
              <Select value={pipelineId} onValueChange={setPipelineId} disabled={integration.is_active || busy}>
                <SelectTrigger><SelectValue placeholder={t("Selecione o funil")} /></SelectTrigger>
                <SelectContent>{funis.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="secondary" onClick={savePipeline} disabled={integration.is_active || busy || !pipelineId || (pipelineId === integration.pipeline_id && lifecycle === integration.lifecycle_enabled)}>{t("Salvar configuração")}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("O funil só pode mudar enquanto a conexão estiver inativa e sem eventos recebidos.")}</p>
            <p>{t("Último evento")}: {integration.last_received_at ? new Date(integration.last_received_at).toLocaleString(idioma) : t("Nenhum")}</p>
            <Label htmlFor="obra-endpoint">{t("Endpoint para o emissor")}</Label>
            <Input id="obra-endpoint" readOnly value={`${typeof window === "undefined" ? "" : window.location.origin}/api/v1/webhooks/obra-no-bolso/${integration.id}`} />
            <p>{integration.lifecycle_enabled ? t("Contrato de teste e assinatura: v2") : t("Envie JSON v1 com headers")} <code>X-Obra-Timestamp</code> {t("e")} <code>X-Obra-Signature</code>. {t("A assinatura é HMAC-SHA256 dos bytes")} <code>timestamp.corpo</code>.</p>
            {secretOnce && (
              <div className="rounded-md border border-amber-500 p-3">
                <p className="font-medium">{t("Segredo exibido uma única vez. Copie para o emissor antes de sair desta tela.")}</p>
                <Input aria-label={t("Segredo de assinatura")} readOnly value={secretOnce} />
                <Button variant="secondary" onClick={() => setSecretOnce(null)}>{t("Já guardei; ocultar")}</Button>
              </div>
            )}
            <Button variant="secondary" onClick={toggle} disabled={busy}>{integration.is_active ? t("Desativar conexão") : t("Ativar conexão")}</Button>
            <p className="text-xs text-muted-foreground">{integration.lifecycle_enabled
              ? t("A conexão recebe estados. As mensagens são ativadas separadamente abaixo, somente neste workspace.")
              : t("A conexão e as automações são controles separados. Regras novas de parabenização nascem pausadas na aba Automações; crie uma condição trial ou paid e um texto para cada.")}</p>
          </div>
        )}
      </section>

      {integration?.lifecycle_enabled && <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-lg font-semibold">{t("Mensagens de teste e assinatura")}</h2>
        <p className="text-sm text-muted-foreground">{t("Até dois contatos no teste: após 2 e 48 horas. A confirmação ocorre após 96 horas completas. Proativos somente em dias úteis, das 8h às 20h; respostas recebidas continuam 24 horas.")}</p>
        <Label htmlFor="obra-message-channel">{t("Número para acompanhamento")}</Label>
        <Select value={outreach.channel_session_id ?? "none"} onValueChange={value => setOutreach({ ...outreach, channel_session_id: value === "none" ? null : value })}>
          <SelectTrigger id="obra-message-channel"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="none">{t("Selecione o número conectado por QR code")}</SelectItem>
            {channels.map(item => <SelectItem value={item.id} key={item.id}>{item.display_name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Label htmlFor="obra-recovery-flow">{t("Fluxo de recuperação")}</Label>
        <Select value={outreach.recovery_pointer_id ?? "none"} onValueChange={value => setOutreach({ ...outreach, recovery_pointer_id: value === "none" ? null : value })}>
          <SelectTrigger id="obra-recovery-flow"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="none">{t("Sem recuperação automática")}</SelectItem>
            {flows.map(item => <SelectItem value={item.id} key={item.id}>{item.name} ({item.status})</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("O fluxo selecionado precisa estar publicado, vinculado ao agente e condicionado à tag followup_assinatura. Essa tag é liberada após confirmar suspensão ou cancelamento depois das 96 horas e aguardar mais 2 horas.")}</p>
        <Label htmlFor="obra-registration-message">{t("Cadastro no teste — após 2 horas")}</Label>
        <Textarea id="obra-registration-message" value={outreach.registration_message} maxLength={2000} onChange={e => setOutreach({ ...outreach, registration_message: e.target.value })} />
        <Label htmlFor="obra-usage-message">{t("Uso no teste — após 48 horas")}</Label>
        <Textarea id="obra-usage-message" value={outreach.usage_message} maxLength={2000} onChange={e => setOutreach({ ...outreach, usage_message: e.target.value })} />
        <Label htmlFor="obra-activation-message">{t("Assinatura confirmada — mensagem única")}</Label>
        <Textarea id="obra-activation-message" value={outreach.activation_message} maxLength={2000} onChange={e => setOutreach({ ...outreach, activation_message: e.target.value })} />
        <p className="text-xs text-muted-foreground">{t("Use {{contact.name}} para o nome. Campo vazio desativa aquela mensagem. Resposta, recusa ou atendimento humano interrompem os retornos; mensagens de teste vencidas são descartadas.")}</p>
        <Label htmlFor="obra-outreach-enabled">{t("Envios deste ciclo")}</Label>
        <Select value={outreach.enabled ? "on" : "off"} onValueChange={value => setOutreach({ ...outreach, enabled: value === "on" })}>
          <SelectTrigger id="obra-outreach-enabled"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="off">{t("Desativados")}</SelectItem><SelectItem value="on">{t("Ativados neste workspace")}</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={saveMessages} disabled={busy || outreach.enabled && !outreach.channel_session_id}>{t("Salvar mensagens")}</Button>
      </section>}

      {integration?.lifecycle_enabled ? <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-lg font-semibold">{t("Estado das assinaturas")}</h2>
        <Button variant="secondary" onClick={() => void refresh()}>{t("Atualizar histórico")}</Button>
        {!state.subscriptions?.length && <p className="text-sm text-muted-foreground">{t("Nenhum estado de assinatura recebido.")}</p>}
        {state.subscriptions?.map(item => <div key={item.id} className="rounded-md border border-border p-3 text-sm">
          <p className="font-medium">{item.contact?.name ?? item.lead?.title ?? t("Contato não identificado")}</p>
          <strong>{t(({ trial: "Em teste", paid: "Assinatura confirmada", recover: "Elegível para recuperação",
            manual: "Conferência necessária", post_conversion: "Suporte após assinatura" } as Record<string, string>)[item.decision] ?? "Conferência necessária")}</strong>
          <p>{t("Início do teste")}: {new Date(item.trial_started_at).toLocaleString(idioma)}</p>
          <p>{t("Última consulta")}: {new Date(item.checked_at).toLocaleString(idioma)}</p>
          {item.reason && <p className="text-muted-foreground">{t("Confira a identificação e o estado do usuário no aplicativo antes de agir.")}</p>}
          <Button variant="secondary" disabled={busy || !integration.is_active} onClick={() => void refreshSubscription(item.id)}>{t("Consultar aplicativo novamente")}</Button>
        </div>)}
        <div className="flex gap-2">
          <Button variant="secondary" disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}>{t("Página anterior")}</Button>
          <Button variant="secondary" disabled={!state.subscription_pagination?.has_more} onClick={() => setHistoryOffset(historyOffset + 50)}>{t("Próxima página")}</Button>
        </div>
      </section> : <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-lg font-semibold">{t("Eventos")}</h2>
        <div className="grid gap-2 text-sm sm:grid-cols-4">
          <p>{t("Processados")}: <strong>{state.counts.processed}</strong> (trial: {state.counts.trial}; paid: {state.counts.paid})</p>
          <p>{t("Pendentes")}: <strong>{state.counts.pending}</strong></p>
          <p>{t("Rejeitados")}: <strong>{state.counts.rejected}</strong></p>
          <p>{t("Duplicados")}: <strong>{state.counts.duplicates}</strong></p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()}>{t("Atualizar histórico")}</Button>
        <Select value={historyStatus} onValueChange={value => { setHistoryStatus(value); setHistoryOffset(0); }}>
          <SelectTrigger aria-label={t("Filtrar eventos")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("Todos")}</SelectItem>
            <SelectItem value="pending">{t("Pendentes")}</SelectItem>
            <SelectItem value="ready">{t("Retomar confirmação")}</SelectItem>
          </SelectContent>
        </Select>
        {state.rejections.length > 0 && <div className="rounded-md border border-border p-3 text-sm">
          <strong>{t("Rejeições técnicas recentes")}</strong>
          {state.rejections.map((item, index) => <p key={`${item.created_at}-${index}`}>
            {new Date(item.created_at).toLocaleString(idioma)} · {item.reason}
          </p>)}
        </div>}
        {state.receipts.length === 0 ? <p className="text-sm text-muted-foreground">{t("Nenhum evento identificado recebido.")}</p> :
          <div className="space-y-2">{state.receipts.map(receipt => (
            <div key={receipt.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{receipt.name ?? t("Contato anonimizado")} · {receipt.modality === "trial" ? t("Teste grátis") : t("Acesso pago")}</strong>
                <span>{receipt.status === "pending" ? t("Pendente de conferência") : receipt.status === "processed" ? t("Processado") : receipt.status === "rejected" ? t("Rejeitado") : receipt.status}</span>
              </div>
              <p>{receipt.email} · {receipt.phone ?? t("Telefone inválido")} · {receipt.plan}</p>
              <p className="text-muted-foreground">{new Date(receipt.created_at).toLocaleString(idioma)}{receipt.reason ? ` · ${t(reasons[receipt.reason] ?? receipt.reason)}` : ""}</p>
              {receipt.status === "pending" && <Button variant="secondary" onClick={() => {
                setPending(receipt); setSearch(receipt.phone ?? receipt.email ?? ""); setContacts([]);
                setContactId(""); setLeadId(""); setLeads([]);
              }}>{t("Conferir associação")}</Button>}
              {["ready", "processing"].includes(receipt.status) && <Button variant="secondary" disabled={busy}
                onClick={() => void retry(receipt.id)}>{t("Retomar confirmação")}</Button>}
            </div>
          ))}</div>}
        <div className="flex gap-2">
          <Button variant="secondary" disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}>{t("Página anterior")}</Button>
          <Button variant="secondary" disabled={!state.pagination.has_more} onClick={() => setHistoryOffset(historyOffset + 50)}>{t("Próxima página")}</Button>
        </div>
      </section>}

      {pending && <section className="space-y-3 rounded-md border border-border p-4" aria-label={t("Conferir evento pendente")}>
        <h2 className="font-semibold">{t("Conferir associação de")} {pending.name}</h2>
        <p className="text-sm">{t("Revise a identidade antes de escolher o contato e uma oportunidade aberta do funil configurado. A confirmação encerra a oportunidade como ganha.")}</p>
        <div className="flex gap-2"><Input aria-label={t("Buscar contato")} value={search} onChange={e => setSearch(e.target.value)} /><Button onClick={findContacts}>{t("Buscar")}</Button></div>
        <Select value={contactId} onValueChange={v => void chooseContact(v)}>
          <SelectTrigger><SelectValue placeholder={t("Selecione um contato")} /></SelectTrigger>
          <SelectContent>{contacts.map(c => <SelectItem key={c.id} value={c.id}>{c.name ?? t("Sem nome")} · {c.email ?? c.phone_number ?? c.id}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={leadId} onValueChange={setLeadId} disabled={!contactId}>
          <SelectTrigger><SelectValue placeholder={t("Selecione uma oportunidade aberta")} /></SelectTrigger>
          <SelectContent>{leads.map(l => <SelectItem key={l.id} value={l.id}>{l.title}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex gap-2"><Button onClick={associate} disabled={!contactId || !leadId || busy}>{t("Confirmar associação")}</Button><Button variant="ghost" onClick={() => setPending(null)}>{t("Cancelar")}</Button></div>
      </section>}
    </div>
  );
}
