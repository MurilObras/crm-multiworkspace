"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { canSendManually, HISTORY_STATES, historyExplanation, type KiwifyHistoryRow } from "@/lib/automation/kiwify-history";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { ACTION_LABELS, type ActionType } from "./labels";
import { KiwifySendDialog } from "./KiwifySendDialog";

export function KiwifyHistoryTab({organizationId}:{organizationId:string}) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const [filters,setFilters] = useState({ search: "", status: "", from: "", to: "" });
  const [page,setPage] = useState(1);
  const [sendRow,setSendRow] = useState<KiwifyHistoryRow | null>(null);
  const query = useQuery({ queryKey: ["kiwify-history",organizationId,filters,page], gcTime:0, queryFn: async () => {
    const params = new URLSearchParams({ page: String(page) });
    for (const [key,value] of Object.entries(filters)) if (value) params.set(key,value);
    const response = await fetch(`/api/v1/integrations/kiwify/history?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("history_unavailable");
    return (await response.json()).data as { rows: KiwifyHistoryRow[]; has_more: boolean };
  } });
  const change = (key: keyof typeof filters, value: string) => { setFilters(f => ({ ...f,[key]:value })); setPage(1); };
  const date = (value: string | null) => value ? new Date(value).toLocaleString(idioma) : t("Não disponível");
  return <section className="space-y-4 pt-4" aria-label={t("Acompanhamento Kiwify")}>
    <p className="text-sm text-muted-foreground">{t("Consulta de compras e mensagens. O recebimento da compra e o envio são fases diferentes.")}</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="block text-sm">{t("Compra, nome ou telefone")}<Input value={filters.search} onChange={e => change("search",e.target.value)} /></label>
      <label className="block text-sm">{t("Situação")}<select className="h-9 w-full rounded-md border bg-background px-2" value={filters.status} onChange={e => change("status",e.target.value)}>
        <option value="">{t("Todas")}</option>{Object.entries(HISTORY_STATES).filter(([key])=>key!=="preparing").map(([key,label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select></label>
      <label className="block text-sm">{t("De (UTC)")}<Input type="date" value={filters.from} onChange={e => change("from",e.target.value)} /></label>
      <label className="block text-sm">{t("Até (UTC)")}<Input type="date" value={filters.to} onChange={e => change("to",e.target.value)} /></label>
    </div>
    {query.isPending || query.isFetching ? <Skeleton className="h-40 w-full" aria-label={t("Carregando histórico")} />
      : query.isError ? <p role="alert">{t("Não foi possível consultar o histórico. Atualize a página para consultar novamente.")}</p>
      : !query.data.rows.length ? <p>{t("Nenhuma compra encontrada para esses filtros.")}</p>
      : query.data.rows.map(row => <Card key={`${row.receipt_id}:${row.run_id ?? "intake"}:${row.message_id ?? "none"}`}><CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{t("Compra")} {row.order_id}</h3><strong>{t(HISTORY_STATES[row.status])}</strong></div>
        <p className="text-sm">{t("Entrada")}: {row.intake_status === "accepted" || row.intake_status === "accepted_no_phone" ? t("Compra aceita") : t("Compra não aceita")}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {[["Lead",row.lead_title],["Nome atual",row.contact_name],["Telefone da tentativa",row.destination_phone],
            ["Telefone atual",row.current_phone],["Produto",row.product_name],[t("Automação"),row.rule_name],
            [t("Ação"),row.action_type ? `${row.action_index === null ? "" : `${row.action_index+1} — `}${t(ACTION_LABELS[row.action_type as ActionType] ?? "Ação")}` : null],["Canal",row.channel],
            ["Tentativa",date(row.attempted_at)],[t("Última atualização"),date(row.updated_at)]].map(([label,value]) =>
            <div key={label}><dt className="text-muted-foreground">{t(label!)}</dt><dd className="break-words">{value || t("Não disponível")}</dd></div>)}
        </dl>
        <p className="text-sm">{t(historyExplanation(row))}</p>
        <nav className="flex flex-wrap gap-4 text-sm" aria-label={t("Cadastros relacionados")}>
          {row.lead_id && <Link className="underline" href={`/app/leads/${row.lead_id}`}>{t("Abrir lead")}</Link>}
          {row.contact_id && <Link className="underline" href={`/app/contacts/${row.contact_id}`}>{t("Abrir contato")}</Link>}
          {row.conversation_id && <Link className="underline" href={`/app/inbox/${row.conversation_id}`}>{t("Abrir conversa")}</Link>}
          {!row.conversation_id && <span className="text-muted-foreground no-underline">{t("Sem conversa disponível para este registro.")}</span>}
        </nav>
        {canSendManually(row) ? (
          <div className="flex justify-end">
            <Button type="button" onClick={() => setSendRow(row)}>{t("Enviar mensagem")}</Button>
          </div>
        ) : null}
      </CardContent></Card>)}
    <div className="flex items-center justify-between gap-3">
      <Button variant="secondary" disabled={page===1 || query.isFetching} onClick={() => setPage(p=>p-1)}>{t("Anterior")}</Button>
      <span>{t("Página")} {page}</span>
      <Button variant="secondary" disabled={!query.data?.has_more || query.isFetching} onClick={() => setPage(p=>p+1)}>{t("Próxima")}</Button>
    </div>
    <KiwifySendDialog open={!!sendRow} onOpenChange={(open) => !open && setSendRow(null)} row={sendRow} />
  </section>;
}
