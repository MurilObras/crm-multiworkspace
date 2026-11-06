"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export function ReprocessMedia({ messageId }: { messageId: string }) {
  const t = useT();
  const query = useQueryClient();
  const retry = useMutation({
    mutationFn: () => apiClient.post(`/api/v1/messages/${messageId}/reprocess`, {}),
    onSuccess: () => { void query.invalidateQueries({ queryKey: ["messages"] }); },
    onError: showApiError,
  });
  return <div className="mt-2 space-y-1">
    <p className="text-xs text-muted-foreground">{t(retry.isSuccess ? "Processamento solicitado. Nenhuma resposta será enviada ao cliente." : "A leitura desta mídia falhou. Reprocessar não envia resposta ao cliente.")}</p>
    <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={retry.isPending || retry.isSuccess} onClick={() => retry.mutate()}>
      {t(retry.isPending ? "Solicitando…" : retry.isSuccess ? "Processamento solicitado" : "Reprocessar mídia")}
    </Button>
  </div>;
}
