"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Microphone, PaperPlaneTilt, Trash } from "@/lib/ui/icons";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";

const PREFERRED_MIMES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIMES.find((m) => MediaRecorder.isTypeSupported(m));
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  resolveCaseId?: string;
  onSendStart?: () => void;
  onResolutionMessage?: (messageId: string) => void;
}

/** Gravação de voz estilo WhatsApp: mic → timer + cancelar/enviar → PTT. */
export function AudioRecorder({ conversationId, disabled, resolveCaseId, onSendStart, onResolutionMessage }: Props) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const startingRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const selection = useRef({ resolveCaseId, onSendStart, onResolutionMessage, disabled });
  useEffect(() => { selection.current = { resolveCaseId, onSendStart, onResolutionMessage, disabled }; },
    [resolveCaseId, onSendStart, onResolutionMessage, disabled]);
  const upload = useUploadMedia();
  const send = useSendMessage();

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  };

  // Trocar de conversa/rota no meio de uma gravação não pode deixar o mic aberto.
  useEffect(
    () => { const currentGeneration = generation.current; mounted.current = true; return () => {
      mounted.current = false;
      generation.current = currentGeneration + 1;
      discardRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      cleanupStream();
    }; },
    [conversationId],
  );

  async function start() {
    if (startingRef.current || recording || disabled || upload.isPending || send.isPending) return;
    startingRef.current = true;
    const startedGeneration = generation.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || generation.current !== startedGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        cleanupStream();
        setRecording(false);
        setElapsed(0);
        if (!mounted.current || generation.current !== startedGeneration || discardRef.current || chunksRef.current.length === 0) return;
        const chosen = selection.current;
        if (chosen.disabled) return;
        chosen.onSendStart?.();
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        void upload
          .mutateAsync({ conversationId, file: blob, filename: `ptt.${type.includes("ogg") ? "ogg" : "webm"}` })
          .then((uploaded) => {
            if (!mounted.current || generation.current !== startedGeneration) return;
            send.mutate(
              {
                conversation_id: conversationId,
                type: "audio",
                media_storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
                ...(chosen.resolveCaseId ? { resolve_case_id: chosen.resolveCaseId } : {}),
              },
              { onSuccess: (result) => {
                if (mounted.current && generation.current === startedGeneration && chosen.resolveCaseId) chosen.onResolutionMessage?.(result.data.id);
              } },
            );
          })
          .catch(() => {
            // toast já disparado pelo onError de useUploadMedia
          });
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      cleanupStream();
      // permissão negada / sem mic — não gravar é o estado final; toast simples
      const { showApiError } = await import("@/components/feedback/ApiErrorToast");
      showApiError(new Error(t("Não consegui acessar o microfone. Verifique a permissão do navegador.")));
    } finally {
      startingRef.current = false;
    }
  }

  function stopIfRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  if (!recording) {
    return (
      <Button
        type="button"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label={t("Gravar áudio")}
        onClick={start}
        disabled={disabled || upload.isPending || send.isPending}
      >
        <Microphone size={16} weight="fill" aria-hidden />
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 shrink-0 text-destructive"
        aria-label={t("Cancelar gravação")}
        onClick={() => {
          discardRef.current = true;
          stopIfRecording();
        }}
      >
        <Trash size={16} weight="regular" aria-hidden />
      </Button>
      <span className="flex items-center gap-1.5 text-sm tabular-nums text-destructive">
        <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden />
        {fmt(elapsed)}
      </span>
      <Button
        type="button"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label={t("Enviar áudio")}
        disabled={disabled || upload.isPending || send.isPending}
        onClick={() => { if (!selection.current.disabled && !upload.isPending && !send.isPending) stopIfRecording(); }}
      >
        <PaperPlaneTilt size={16} weight="fill" aria-hidden />
      </Button>
    </div>
  );
}
