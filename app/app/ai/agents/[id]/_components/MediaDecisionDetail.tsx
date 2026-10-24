"use client";
import type { MediaDiagnostic } from "@/lib/ai/agents/media-simulation";
import { useT } from "@/hooks/i18n/useT";

export function MediaDecisionDetail({ decision }: { decision: MediaDiagnostic }) {
  const t = useT();
  return (
    <div className="space-y-1 rounded-md border p-3 text-xs" data-testid="media-decision">
      <p className="font-medium">{t("Decisão de mídia")}</p>
      <p>
        {t("Intenção:")} {decision.intent} {decision.format ? `(${decision.format})` : ""}
      </p>
      <p>
        {t("Arquivo:")} {decision.title ?? decision.media_id ?? t("Nenhum")}
      </p>
      <p>
        {t("Autorização:")} {decision.authorized ? t("Permitida") : t("Bloqueada")}
      </p>
      <p>
        {t("Motivo:")} {decision.reason}
      </p>
      <p>
        {t("Transporte:")} {decision.transport}
      </p>
      {decision.transport === "planned" && (
        <p>
          {t("Somente planejamento. Nenhum arquivo foi transportado nem entregue neste ensaio.")}
        </p>
      )}
    </div>
  );
}
