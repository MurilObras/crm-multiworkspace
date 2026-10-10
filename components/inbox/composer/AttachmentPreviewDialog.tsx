"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";

interface Props {
  file: File | null;
  sending: boolean;
  onCancel: () => void;
  onSend: (caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): thumb ou card + legenda. */
export function AttachmentPreviewDialog({ file, sending, onCancel, onSend }: Props) {
  const t = useT();
  const [caption, setCaption] = useState("");
  useEffect(() => setCaption(""), [file]);

  const objectUrl = useMemo(() => (file && /^(image|video|audio)\//.test(file.type) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!file) return null;
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith('audio/');

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Enviar anexo")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-center rounded-lg bg-muted/40 p-3">
          {isImage && objectUrl && (
            <img src={objectUrl} alt={file.name} className="max-h-64 rounded-md object-contain" />
          )}
          {isVideo && objectUrl && <video src={objectUrl} controls className="max-h-64 rounded-md" />}
          {isAudio && objectUrl && <audio src={objectUrl} controls className="w-full" aria-label={t('Ouvir áudio antes de enviar')} />}
          {!isImage && !isVideo && !isAudio && (
            <div className="flex items-center gap-3 py-4">
              <FileText size={28} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
            </div>
          )}
        </div>
        {isAudio ? <p className="text-xs text-muted-foreground">{t('O áudio será enviado sem legenda. Envie uma mensagem de texto separada se precisar dar contexto.')}</p> : <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={t("Legenda (opcional)")}
          aria-label={t("Legenda")}
          onKeyDown={(e) => e.key === "Enter" && !sending && onSend(caption.trim())}
        />}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => onSend(isAudio ? '' : caption.trim())} disabled={sending}>
            {t("Enviar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
