"use client";
import * as React from "react";
import { useT } from "@/hooks/i18n/useT";

interface State {
  requests: { id: string; kind: string; status: string; answered_by: string | null }[];
  deliveries: { id: string; purpose: string; status: string; responsible_name: string | null; format: string | null }[];
}
const labels: Record<string, string> = { pending: "Aguardando", answered: "Resposta recebida; entrega pendente", delivered: "Entregue ao cliente",
  sending: "Enviando",
  cancelled: "Encerrado", failed: "Falha; verifique o atendimento", uncertain: "Entrega incerta; não reenviar automaticamente", blocked: "Envio impedido", sent: "Enviado",
  wait_notice: "Aviso ao cliente", notification: "Aviso ao responsável", answer: "Resposta ao cliente", receipt: "Confirmação ao responsável" };

export function ResponsibleDeliveryStatus({ caseId }: { caseId: string }) {
  const t = useT();
  const [data, setData] = React.useState<State | null>(null);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/v1/ai/cases/${caseId}/responsibles`);
        if (!response.ok) throw new Error("unavailable");
        const json = await response.json();
        if (active) { setData(json.data); setError(false); }
      } catch { if (active) setError(true); }
    }
    setData(null); void load(); const timer = setInterval(load, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [caseId]);
  if (error) return <p role="alert" className="text-xs">{t("Não foi possível atualizar as entregas pelo WhatsApp.")}</p>;
  if (!data?.requests.length) return null;
  return <section className="space-y-2 rounded-md border p-3" aria-label={t("Consulta pelo WhatsApp")}>
    <h3 className="text-sm font-medium">{t("Consulta pelo WhatsApp")}</h3>
    {data.requests.map(r => <p key={r.id} className="text-xs">{t(r.kind === "handoff" ? "Atendimento humano" : "Consulta ao responsável")}: {t(labels[r.status] ?? r.status)}{r.answered_by ? ` · ${r.answered_by}` : ""}</p>)}
    <ul className="space-y-1">{data.deliveries.map(d => <li key={d.id} className="text-xs">{t(labels[d.purpose] ?? d.purpose)}{d.responsible_name ? ` · ${d.responsible_name}` : ""}: {t(labels[d.status] ?? d.status)}{d.format === "audio" ? ` (${t("áudio")})` : ""}</li>)}</ul>
  </section>;
}
