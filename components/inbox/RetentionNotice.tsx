"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowsClockwise, Scales, ShieldCheck } from "@/lib/ui/icons";
import { retentionCopy, type RetentionKind } from "@/lib/inbox/retention-copy";
import { useRetention } from "@/hooks/inbox/useRetention";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<RetentionKind, typeof ShieldCheck> = {
  protection: ShieldCheck,
  compliance: Scales,
  quality: ArrowsClockwise,
};

const KIND_CLASS: Record<RetentionKind, string> = {
  protection: "border-warning bg-warning-bg text-warning-fg",
  compliance: "border-destructive/40 bg-destructive/10 text-destructive",
  quality: "border-border bg-muted/40 text-muted-foreground",
};

/**
 * Aviso de transparência do anti-ban (Operação Visível F2-i): quando a cadeia
 * before_send reteve a resposta do assistente nas últimas 24h, mostra o MOTIVO
 * traduzido em pt-br leigo acima do composer. Sem veto recente → não renderiza.
 */
export function RetentionNotice({ conversationId, organizationId }: { conversationId: string; organizationId?:string|null }) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data } = useRetention(conversationId,organizationId);
  const latest = data?.retentions[0];
  if (!latest || !data) return null;

  const original = retentionCopy(latest.vetoed_code, data.context, t);
  const copy = latest.delivery_state === 'historical'
    ? { ...original, title: t('Ocorrência anterior de envio'), description: t('Há um bloqueio registrado anteriormente, sem vínculo suficiente para confirmar se continua pendente. Consulte o histórico do atendimento.') }
    : latest.delivery_state === 'uncertain'
      ? { ...original, title: t('Entrega sem confirmação'), description: t('Não foi possível confirmar esta entrega. Confira o atendimento antes de reenviar para evitar duplicação.') }
      : latest.delivery_state === 'partial'
        ? { ...original, title: t('Resposta enviada parcialmente'), description: t('Parte desta resposta chegou ao cliente; outra parte continua pendente. O histórico identifica a tentativa afetada.') }
        : original;
  const Icon = KIND_ICON[copy.kind];
  const when = formatDistanceToNowStrict(new Date(latest.created_at), {
    addSuffix: true,
    locale: localeDaData,
  });

  return (
    <div
      data-testid="retention-notice"
      className={cn("flex items-start gap-2.5 border-t px-4 py-2.5 text-xs", KIND_CLASS[copy.kind])}
    >
      <Icon size={16} weight="duotone" className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">
          {copy.title}
          <span className="ml-2 font-normal opacity-70">{when}</span>
        </p>
        <p className="mt-0.5 opacity-90">{copy.description}</p>
      </div>
    </div>
  );
}
