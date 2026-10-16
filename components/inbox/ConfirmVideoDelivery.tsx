"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MediaRenderer } from "./media/MediaRenderer";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import type { Message } from "@/lib/types/messaging";

/** Reparação explícita de uma confirmação perdida. Nunca envia outra mensagem. */
export function ConfirmVideoDelivery({ message }: { message: Message }) {
  const t = useT(),
    qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [echo, setEcho] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/v1/messages/${message.id}/delivery-confirmation`;
  const candidates = useQuery({
    queryKey: ["delivery-confirmation", message.id],
    enabled: open,
    queryFn: () => apiClient.get<{ data: Message[] }>(endpoint),
    retry: false,
    staleTime: 0,
  });
  async function save() {
    if (!echo || !confirmed) return;
    setPending(true);
    setError(null);
    try {
      await apiClient.post(
        endpoint,
        { echo_id: echo, confirmed_same_video: true },
        { maxAttempts: 1 },
      );
      await qc.invalidateQueries({ queryKey: ["messages", message.conversation_id] });
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Não foi possível confirmar a entrega."));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setEcho("");
          setConfirmed(false);
          setError(null);
          setOpen(true);
        }}
      >
        {t("Confirmar vídeo recebido")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("Confirmar vídeo recebido")}</DialogTitle>
            <DialogDescription>
              {t(
                "Confira no WhatsApp se este vídeo chegou. Selecione abaixo a cópia recebida do mesmo vídeo. Esta ação corrige o registro e não envia outra mensagem.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="max-w-64">
            <MediaRenderer message={message} />
          </div>
          {candidates.isPending ? <p>{t("Carregando…")}</p> : null}
          {candidates.isError ? (
            <p role="alert">{t("Não foi possível consultar as entregas.")}</p>
          ) : null}
          {candidates.data?.data.length === 0 ? (
            <p>
              {t(
                "Nenhuma cópia recebida foi encontrada. A entrega permanece incerta; não confirme sem verificar.",
              )}
            </p>
          ) : null}
          {candidates.data?.data.map((candidate) => (
            <div key={candidate.id} className="rounded-md border p-3">
              <label className="flex gap-2">
                <input
                  type="radio"
                  name="video-confirmation"
                  value={candidate.id}
                  checked={echo === candidate.id}
                  onChange={() => {
                    setEcho(candidate.id);
                    setConfirmed(false);
                  }}
                  disabled={pending}
                />
                {new Date(candidate.sent_at).toLocaleTimeString()}
              </label>
              <div className="max-w-64">
                <MediaRenderer message={candidate} />
              </div>
            </div>
          ))}
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!echo || pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t("Conferi no WhatsApp: é o mesmo vídeo e foi recebido.")}
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button disabled={!echo || !confirmed || pending} onClick={save}>
            {pending ? t("Salvando…") : t("Confirmar entrega")}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
