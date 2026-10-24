"use client";

import { useEffect, useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  readMediaReplayPolicy,
  type MediaReplayPolicy as Policy,
} from "@/lib/ai/agents/media-replay-policy";
import { useT } from "@/hooks/i18n/useT";

export function MediaReplayPolicy(props: { agentId: string; readOnly: boolean }) {
  return <MediaReplayPolicyForm key={props.agentId} {...props} />;
}
function MediaReplayPolicyForm({ agentId, readOnly }: { agentId: string; readOnly: boolean }) {
  const t = useT();
  const id = useId();
  const [policy, setPolicy] = useState<Policy>("explicit_media_request");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/v1/ai/agents/${agentId}`, { signal: abort.signal, cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(t("Não foi possível carregar a política de reenvio."));
        if (!abort.signal.aborted) {
          setPolicy(readMediaReplayPolicy(json.data?.config));
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setFeedback(error instanceof Error ? error.message : t("Erro ao carregar."));
      });
    return () => abort.abort();
  }, [agentId, t]);
  async function save() {
    setBusy(true);
    setFeedback("");
    try {
      const res = await fetch(`/api/v1/ai/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { media_replay_policy: policy } }),
      });
      if (!res.ok) throw new Error(t("Não foi possível salvar. Recarregue e tente novamente."));
      // Confirma a leitura persistida; não confirma só o clique.
      const check = await fetch(`/api/v1/ai/agents/${agentId}`, { cache: "no-store" });
      const json = await check.json();
      if (!check.ok || readMediaReplayPolicy(json.data?.config) !== policy)
        throw new Error(t("Não foi possível confirmar a configuração salva."));
      setFeedback(t("Política de reenvio salva e conferida."));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("Falha ao salvar."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label htmlFor={id}>{t("Política de reenvio de áudio, foto e vídeo")}</Label>
      <select
        id={id}
        className="w-full rounded-md border bg-background p-2 text-sm"
        value={policy}
        disabled={!loaded || busy || readOnly}
        onChange={(e) => setPolicy(e.target.value as Policy)}
      >
        <option value="explicit_media_request">
          {t("Pedido explícito de mídia (compatibilidade)")}
        </option>
        <option value="explicit_repeat">{t("Somente pedido claro de repetição")}</option>
      </select>
      <p className="text-xs text-muted-foreground">
        {policy === "explicit_repeat"
          ? t(
              "Após receber o arquivo, repetir o assunto recebe texto. “Mostra de novo” permite reenvio se a opção do arquivo estiver ligada.",
            )
          : t(
              "Após receber o arquivo, um novo pedido explícito do formato permite reenvio se a opção do arquivo estiver ligada.",
            )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "Vale só para este agente. Não libera arquivos desativados, outras etapas, atendimento humano ou entregas pendentes/incertas.",
        )}
      </p>
      {!readOnly && (
        <Button type="button" size="sm" disabled={!loaded || busy} onClick={() => void save()}>
          {t("Salvar política de reenvio")}
        </Button>
      )}
      {feedback && (
        <p role="status" className="text-xs">
          {feedback}
        </p>
      )}
    </div>
  );
}
