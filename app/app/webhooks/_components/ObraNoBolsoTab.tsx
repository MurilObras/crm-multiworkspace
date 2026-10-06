"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";

type Receipt = {
  id: string; external_event_id: string; product_user_id: string; occurred_at: string;
  name: string | null; email: string | null; phone: string | null; plan: string; modality: "trial" | "paid";
  provider: string | null; status: string; reason: string | null;
  contact_id: string | null; lead_id: string | null; duplicate_count: number; created_at: string;
};
type State = {
  integration: { id: string; pipeline_id: string; is_active: boolean; last_received_at: string | null } | null;
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
  const [state, setState] = React.useState<State | null>(null);
  const [pipelines, setPipelines] = React.useState<Array<{ id: string; name: string }>>([]);
  const [pipelineId, setPipelineId] = React.useState("");
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
      if (next.integration) setPipelineId(next.integration.pipeline_id);
    } catch (error) { toast.error((error as Error).message); }
  }, [historyUrl]);
  React.useEffect(() => {
    let cancelled = false;
    void api<State>(historyUrl).then(next => {
      if (cancelled) return;
      setState(next);
      if (next.integration) setPipelineId(next.integration.pipeline_id);
    }).catch((error: Error) => toast.error(error.message));
    void api<Array<{ id: string; name: string }>>("/api/v1/pipelines")
      .then(setPipelines).catch(() => toast.error(t("Funis indisponíveis.")));
    return () => { cancelled = true; };
  }, [t, historyUrl]);

  const create = async () => {
    if (!pipelineId) return;
    setBusy(true);
    try {
      const created = await api<{ signing_secret: string }>(root, {
        method: "POST", body: JSON.stringify({ pipeline_id: pipelineId }),
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
      await api(root, { method: "PATCH", body: JSON.stringify({ pipeline_id: pipelineId }) });
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

  if (!state) return <p className="pt-4 text-sm text-muted-foreground">{t("Carregando integração…")}</p>;
  const integration = state.integration;
  return (
    <div className="space-y-6 pt-4">
      <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-lg font-semibold">Obra no Bolso</h2>
        <p className="text-sm text-muted-foreground">{t("A conversão vem do primeiro acesso liberado pelo produto. O CRM não consulta pagamentos.")}</p>
        {!integration ? (
          <div className="space-y-2">
            <Label>{t("Funil de assinaturas")}</Label>
            <Select value={pipelineId} onValueChange={setPipelineId}>
              <SelectTrigger><SelectValue placeholder={t("Selecione o funil")} /></SelectTrigger>
              <SelectContent>{pipelines.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
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
                <SelectContent>{pipelines.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="secondary" onClick={savePipeline} disabled={integration.is_active || busy || !pipelineId || pipelineId === integration.pipeline_id}>{t("Salvar funil")}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("O funil só pode mudar enquanto a conexão estiver inativa e sem eventos recebidos.")}</p>
            <p>{t("Último evento")}: {integration.last_received_at ? new Date(integration.last_received_at).toLocaleString("pt-BR") : t("Nenhum")}</p>
            <Label htmlFor="obra-endpoint">{t("Endpoint para o emissor")}</Label>
            <Input id="obra-endpoint" readOnly value={`${typeof window === "undefined" ? "" : window.location.origin}/api/v1/webhooks/obra-no-bolso/${integration.id}`} />
            <p>{t("Envie JSON v1 com headers")} <code>X-Obra-Timestamp</code> {t("e")} <code>X-Obra-Signature</code>. {t("A assinatura é HMAC-SHA256 dos bytes")} <code>timestamp.corpo</code>.</p>
            {secretOnce && (
              <div className="rounded-md border border-amber-500 p-3">
                <p className="font-medium">{t("Segredo exibido uma única vez. Copie para o emissor antes de sair desta tela.")}</p>
                <Input aria-label={t("Segredo de assinatura")} readOnly value={secretOnce} />
                <Button variant="secondary" onClick={() => setSecretOnce(null)}>{t("Já guardei; ocultar")}</Button>
              </div>
            )}
            <Button variant="secondary" onClick={toggle} disabled={busy}>{integration.is_active ? t("Desativar conexão") : t("Ativar conexão")}</Button>
            <p className="text-xs text-muted-foreground">{t("A conexão e as automações são controles separados. Regras novas de parabenização nascem pausadas na aba Automações; crie uma condição trial ou paid e um texto para cada.")}</p>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-border p-4">
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
            {new Date(item.created_at).toLocaleString("pt-BR")} · {item.reason}
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
              <p className="text-muted-foreground">{new Date(receipt.created_at).toLocaleString("pt-BR")}{receipt.reason ? ` · ${t(reasons[receipt.reason] ?? receipt.reason)}` : ""}</p>
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
      </section>

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
