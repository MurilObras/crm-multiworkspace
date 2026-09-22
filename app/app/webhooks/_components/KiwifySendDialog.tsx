"use client";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { AutomationTemplateFields } from "./AutomationTemplateFields";
import { useT } from "@/hooks/i18n/useT";
import type { KiwifyHistoryRow } from "@/lib/automation/kiwify-history";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: KiwifyHistoryRow | null;
}

/**
 * Envio MANUAL a partir de uma compra Kiwify elegível.
 *
 * Não transporta nada por conta própria: abre a conversa na sessão escolhida
 * (`POST /api/v1/conversations/open-with-contact`) e delega o envio ao sink
 * canônico (`POST /api/v1/messages`), que conserva opt-out, bloqueio, janela de
 * 24h, templates, idempotência e ledger. A janela fechada é recusada lá — aqui
 * só orientamos texto livre vs. template.
 */
export function KiwifySendDialog({ open, onOpenChange, row }: Props) {
  const t = useT();
  const { data: sessions } = useChannelSessions();

  const [channelSessionId, setChannelSessionId] = React.useState("");
  const [mode, setMode] = React.useState<"text" | "official">("text");
  const [body, setBody] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [templateLanguage, setTemplateLanguage] = React.useState("");
  const [templateValues, setTemplateValues] = React.useState<Record<string, string>>({});
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setChannelSessionId("");
    setMode("text");
    setBody("");
    setTemplateName("");
    setTemplateLanguage("");
    setTemplateValues({});
  }, [open]);

  const eligible = (sessions ?? []).filter((s) => s.status === "WORKING");

  const contactLabel = row?.contact_name || row?.current_phone || t("Destinatário");

  const canConfirm = channelSessionId && (mode === "text" ? body.trim().length > 0 : Boolean(templateName && templateLanguage));

  const submit = async () => {
    if (!row?.contact_id || !canConfirm || sending) return;
    setSending(true);
    try {
      const opened = await apiClient.post<{ data: { conversation_id: string; contact_id: string } }>(
        "/api/v1/conversations/open-with-contact",
        { contact_id: row.contact_id, channel_session_id: channelSessionId },
      );
      const conversationId = opened.data.conversation_id;
      if (mode === "text") {
        await apiClient.post("/api/v1/messages", {
          conversation_id: conversationId,
          type: "text",
          body: body.trim(),
        });
      } else {
        await apiClient.post("/api/v1/messages", {
          conversation_id: conversationId,
          type: "template",
          template_name: templateName,
          template_language: templateLanguage,
          template_values: templateValues,
        });
      }
      toast.success(t("Mensagem enviada."));
      onOpenChange(false);
    } catch (err) {
      showApiError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Enviar mensagem")}</DialogTitle>
          <DialogDescription>
            {t("A mensagem sai pelo sink padrão do CRM, respeitando bloqueio, opt-out, janela de 24h e templates.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-sm border border-border bg-muted/40 p-3 text-sm">
            <p className="text-muted-foreground">{t("Destinatário")}</p>
            <p className="font-medium">{contactLabel}</p>
            {row?.current_phone ? <p className="text-muted-foreground">{row.current_phone}</p> : null}
          </div>

          <div className="space-y-1">
            <Label>{t("Número de WhatsApp")}</Label>
            <Select value={channelSessionId} onValueChange={setChannelSessionId}>
              <SelectTrigger><SelectValue placeholder={t("Escolha o número")} /></SelectTrigger>
              <SelectContent>
                {eligible.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{channelLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {eligible.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("Nenhum número conectado disponível para envio.")}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label>{t("Mensagem")}</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "text" | "official")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="text">{t("Texto livre")}</SelectItem>
                <SelectItem value="official">{t("Template aprovado")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "text" ? (
            <>
              <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("Oi {{nome}}, obrigado pela compra!")} />
              <p className="text-xs text-muted-foreground">
                {t("Texto livre só sai dentro da janela de 24h; fora dela, use um template aprovado.")}
              </p>
            </>
          ) : (
            <AutomationTemplateFields
              config={{ channel_session_id: channelSessionId, template_name: templateName, template_language: templateLanguage, template_values: templateValues }}
              onChange={(c) => {
                setTemplateName(c.template_name ?? "");
                setTemplateLanguage(c.template_language ?? "");
                setTemplateValues(c.template_values ?? {});
              }}
            />
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            {t("Cancelar")}
          </Button>
          <Button type="button" onClick={submit} disabled={!canConfirm || sending}>
            {sending ? t("Enviando…") : t("Confirmar envio")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
