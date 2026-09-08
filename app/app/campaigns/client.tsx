"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type Campaign, type RecipientStatus, recipientStatuses } from "@/lib/campaigns/schema";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { randomId } from "@/lib/random-id";

const labels: Record<RecipientStatus, string> = {
  pending: "Pendentes", sent: "Enviados", failed: "Falhas",
  skipped_opt_out: "Opt-out", stopped_reply: "Parados (resposta)",
};
const stepLabels: Record<RecipientStatus, string> = {
  pending: "Pendente", sent: "Enviado", failed: "Falhou",
  skipped_opt_out: "Opt-out", stopped_reply: "Parado (resposta)",
};
const DELAY_UNITS = [
  { value: "minutes", label: "minutos", factor: 1 },
  { value: "hours", label: "horas", factor: 60 },
  { value: "days", label: "dias", factor: 1440 },
] as const;
type DelayUnit = (typeof DELAY_UNITS)[number]["value"];
type StepDraft = { message: string; delay: string; unit: DelayUnit };

function toMinutes(delay: string, unit: DelayUnit): number {
  const factor = DELAY_UNITS.find((u) => u.value === unit)?.factor ?? 1;
  const value = Number(delay);
  return Number.isFinite(value) && value > 0 ? Math.round(value * factor) : 0;
}
function fromMinutes(minutes: number): { delay: string; unit: DelayUnit } {
  if (minutes % 1440 === 0 && minutes > 0) return { delay: String(minutes / 1440), unit: "days" };
  if (minutes % 60 === 0 && minutes > 0) return { delay: String(minutes / 60), unit: "hours" };
  return { delay: String(minutes), unit: "minutes" };
}

type Channel = { id: string; phone_number: string | null };
type RecipientStep = { step_index: number; status: RecipientStatus; message_id: string | null; failure_reason: string | null };
type Detail = { campaign: Campaign; counts: Record<RecipientStatus, number>; has_more: boolean; recipients: Array<{
  id: string; contact_id: string; steps: RecipientStep[];
}> };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/campaigns${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "Falha ao carregar.");
  return body.data as T;
}

const emptyStep = (): StepDraft => ({ message: "", delay: "", unit: "hours" });
const emptyForm = () => ({ id: "", name: "", channel_session_id: "", tag: "", source: "", hourly_limit: 100, steps: [emptyStep()] });

export function CampaignsClient({ canSend }: { canSend: boolean }) {
  const t = useT();
  const [list, setList] = useState<{ campaigns: Campaign[]; channels: Channel[] }>({ campaigns: [], channels: [] });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [recipientPage, setRecipientPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<{ key: string; count: number } | null>(null);
  const [form, setForm] = useState(emptyForm());
  const filterKey = JSON.stringify([form.tag.trim(), form.source.trim()]);
  const [launchUncertain, setLaunchUncertain] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        if (selected) {
          const data = await api<Detail>(`?id=${selected}&page=${recipientPage}`);
          if (alive) setDetail(data);
        } else {
          const data = await api<typeof list>("");
          if (alive) setList(data);
        }
        if (alive) { setLoaded(true); setError(""); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Falha ao carregar."); }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [selected, recipientPage]);

  function patchStep(index: number, patch: Partial<StepDraft>) {
    setForm({ ...form, steps: form.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  }
  function addStep() { setForm({ ...form, steps: [...form.steps, emptyStep()] }); }
  function removeStep(index: number) { setForm({ ...form, steps: form.steps.filter((_, i) => i !== index) }); }

  const stepsValid = form.steps.every((s, i) => s.message.trim().length > 0 && (i === 0 || toMinutes(s.delay, s.unit) > 0));
  const submitSteps = form.steps.map((s, i) => ({ message: s.message, delay_minutes: i === 0 ? 0 : toMinutes(s.delay, s.unit) }));

  async function showPreview() {
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ preview: "1", tag: form.tag.trim() });
      if (form.source.trim()) query.set("source", form.source.trim());
      const data = await api<{ count: number }>(`?${query}`);
      setPreview({ key: filterKey, count: data.count });
    } catch (e) { setError(e instanceof Error ? e.message : "Falha no preview."); }
    finally { setBusy(false); }
  }

  async function launch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const data = await api<{ id: string }>("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        id: form.id, name: form.name, channel_session_id: form.channel_session_id,
        steps: submitSteps, hourly_limit: form.hourly_limit,
        filters: { tag: form.tag.trim(), ...(form.source.trim() ? { source: form.source.trim() } : {}) },
      }) });
      setRecipientPage(0); setSelected(data.id); setCreating(false); setLaunchUncertain(false);
    } catch (e) {
      setLaunchUncertain(true);
      setError(`${e instanceof Error ? e.message : "Falha ao iniciar."} Confira a lista antes de criar outra campanha. Repetir usa o mesmo ID.`);
    } finally { setBusy(false); }
  }

  return <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">{t("Campanhas WhatsApp")}</h1><p className="text-sm text-muted-foreground">{t("Sequencia de mensagens, publico por tag e limite por hora por canal.")}</p></div>
      {canSend && !creating && !selected && <Button onClick={() => {
        setForm({ ...emptyForm(), id: randomId() });
        setPreview(null); setLaunchUncertain(false); setCreating(true);
      }}>{t("Nova campanha")}</Button>}
      {(creating || selected) && <Button variant="outline" onClick={() => { setCreating(false); setSelected(null); setDetail(null); }}>{t("Voltar para lista")}</Button>}
    </header>
    {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
    {creating ? <form onSubmit={launch} className="space-y-4 rounded-lg border bg-card p-5">
      <fieldset disabled={busy || launchUncertain} className="grid gap-4 md:grid-cols-2">
        <label className="block space-y-1 text-sm">{t("Nome")}<Input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="block space-y-1 text-sm">{t("Canal WhatsApp")}<select required className="h-9 w-full rounded-md border bg-background px-3" value={form.channel_session_id} onChange={(e) => setForm({ ...form, channel_session_id: e.target.value })}>
          <option value="">{t("Selecione um canal conectado")}</option>{list.channels.map((c) => <option key={c.id} value={c.id}>{c.phone_number ?? c.id}</option>)}
        </select></label>
        <label className="block space-y-1 text-sm">{t("Tag")}<Input required maxLength={100} value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} /></label>
        <label className="block space-y-1 text-sm">{t("Origem (opcional)")}<Input maxLength={100} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
        <label className="block space-y-1 text-sm">{t("Limite por hora")}<Input required type="number" min={1} max={10000} value={form.hourly_limit} onChange={(e) => setForm({ ...form, hourly_limit: Number(e.target.value) })} /></label>
      </fieldset>
      <div className="space-y-4">
        <div className="text-sm font-medium">{t("Mensagens")}</div>
        {form.steps.map((step, index) => (
          <div key={index} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{index === 0 ? t("Passo 1 · imediato") : t("Passo {n} · apos o anterior").replace("{n}", String(index + 1))}</span>
              {index > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => removeStep(index)}>{t("Remover")}</Button>}
            </div>
            {index > 0 && <div className="flex items-end gap-2">
              <label className="block flex-1 space-y-1 text-sm">{t("Delay")}
                <Input required type="number" min={1} max={43200} value={step.delay} onChange={(e) => patchStep(index, { delay: e.target.value })} />
              </label>
              <label className="block space-y-1 text-sm">{t("Unidade")}
                <select className="h-9 w-full rounded-md border bg-background px-3" value={step.unit} onChange={(e) => patchStep(index, { unit: e.target.value as DelayUnit })}>
                  {DELAY_UNITS.map((u) => <option key={u.value} value={u.value}>{t(u.label)}</option>)}
                </select>
              </label>
            </div>}
            <label className="block space-y-1 text-sm">{t("Mensagem")}<Textarea required maxLength={4096} rows={3} value={step.message} onChange={(e) => patchStep(index, { message: e.target.value })} /><span className="text-muted-foreground">{t("O texto sera enviado exatamente como escrito. Sem variaveis ou IA.")}</span></label>
          </div>
        ))}
        {form.steps.length < 20 && <Button type="button" variant="outline" onClick={addStep}>{t("+ Adicionar mensagem")}</Button>}
      </div>
      {!list.channels.length && <p className="text-sm">{t("Nenhum canal conectado. Consulte a Central de Conexoes com seu administrador.")}</p>}
      <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={busy || !form.tag.trim() || launchUncertain} onClick={() => void showPreview()}>{t("Calcular publico")}</Button>
        {preview?.key === filterKey && <span role="status">{preview.count} {t("contatos no recorte")}</span>}
      </div>
      <p className="text-sm text-muted-foreground">{t("O publico e congelado ao iniciar. Bloqueios e recusas de marketing sao conferidos antes de cada passo; se o contato responder, os passos seguintes param. O limite conta reservas da ultima hora no canal, compartilhado entre campanhas. Falhas incertas nao sao reenviadas.")}</p>
      <Button disabled={busy || preview?.key !== filterKey || !list.channels.length || !stepsValid} type="submit">{busy ? t("Aguarde...") : launchUncertain ? t("Repetir com o mesmo ID") : t("Enviar agora")}</Button>
    </form> : selected ? detail ? <section className="space-y-5">
      <div><h2 className="text-xl font-medium">{detail.campaign.name}</h2><p className="text-sm text-muted-foreground">{detail.campaign.status === "completed" ? t("Concluida") : t("Em andamento")} · {t("Limite:")} {detail.campaign.hourly_limit}/{t("hora por canal")} · {detail.campaign.steps.length} {t("passo(s)")}</p></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{recipientStatuses.map((s) => <div key={s} className="rounded-lg border bg-card p-4"><p className="text-sm text-muted-foreground">{t(labels[s])}</p><p className="text-2xl font-semibold">{detail.counts[s]}</p></div>)}</div>
      <ol className="space-y-2 rounded-lg border p-4">{detail.campaign.steps.map((step, index) => <li key={index} className="text-sm">{index === 0 ? t("Passo 1 (imediato)") : `${t("Passo")} ${index + 1} (+${fromMinutes(step.delay_minutes).delay} ${t(DELAY_UNITS.find((u) => u.value === fromMinutes(step.delay_minutes).unit)!.label)})`}: <span className="whitespace-pre-wrap break-words">{step.message}</span></li>)}</ol>
      <p className="text-sm text-muted-foreground">{t("Atualiza a cada 10 segundos. Falha incerta pode representar envio em andamento ou interrompido: inspecione a mensagem antes de qualquer nova campanha. Pagina {n}, ate 100 destinatarios por pagina.").replace("{n}", String(recipientPage + 1))}</p>
      <ul className="divide-y rounded-lg border">{detail.recipients.map((r) => <li key={r.id} className="space-y-2 p-3 text-sm">
        <Link className="underline" href={`/app/contacts/${r.contact_id}`}>{r.contact_id}</Link>
        <ul className="flex flex-wrap gap-2">{r.steps.map((s) => <li key={s.step_index} className="rounded-md bg-muted px-2 py-1">P{s.step_index + 1} · {t(stepLabels[s.status])}{s.failure_reason ? ` (${s.failure_reason})` : ""}</li>)}</ul>
      </li>)}</ul>
      <div className="flex gap-3"><Button variant="outline" disabled={recipientPage === 0} onClick={() => { setDetail(null); setRecipientPage(recipientPage - 1); }}>{t("Anterior")}</Button><Button variant="outline" disabled={!detail.has_more} onClick={() => { setDetail(null); setRecipientPage(recipientPage + 1); }}>{t("Proxima")}</Button></div>
    </section> : <p role="status">{t("Carregando campanha...")}</p> : <section className="space-y-3">
      <h2 className="text-lg font-medium">{t("Campanhas recentes")}</h2>
      {!loaded ? <p role="status">{t("Carregando...")}</p> : !list.campaigns.length ? <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{t("Nenhuma campanha criada.")}</p> : list.campaigns.map((c) => <button key={c.id} className="flex w-full flex-wrap justify-between gap-2 rounded-lg border bg-card p-4 text-left hover:bg-muted" onClick={() => { setDetail(null); setRecipientPage(0); setSelected(c.id); }}><span className="font-medium">{c.name}</span><span className="text-sm text-muted-foreground">{c.status === "completed" ? t("Concluida") : t("Em andamento")} · {c.steps.length} {t("passo(s)")} · {c.hourly_limit}/{t("hora")}</span></button>)}
    </section>}
  </div>;
}
