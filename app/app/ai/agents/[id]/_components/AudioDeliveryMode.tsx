'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/hooks/i18n/useT';

export function AudioDeliveryMode({ required, disabled, onChange, allowRepeat = false, onRepeat }: {
  required: boolean; disabled: boolean; onChange: (required: boolean) => void;
  allowRepeat?: boolean; onRepeat?: (allow: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  return <div className="space-y-2 rounded-md border p-3">
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id}>{t('Envio obrigatório')}</Label>
      <Switch id={id} checked={required} disabled={disabled} onCheckedChange={onChange} aria-describedby={`${id}-help`} />
    </div>
    <p id={`${id}-help`} className="text-xs text-muted-foreground">{required
      ? t('Ligado: quando surgir o assunto configurado, envia a mídia nesta interação, dentro das etapas permitidas. O cliente não precisa pedir áudio, foto ou vídeo. Estar na etapa não basta.')
      : t('Desligado: o agente pode escolher a mídia quando for pertinente ou responder por texto.')}</p>
    {onRepeat && <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-repeat`}>{t('Permitir reenvio a pedido explícito')}</Label>
        <Switch id={`${id}-repeat`} checked={allowRepeat} disabled={disabled} onCheckedChange={onRepeat} aria-describedby={`${id}-repeat-help`} />
      </div>
      <p id={`${id}-repeat-help`} className="text-xs text-muted-foreground">{allowRepeat
        ? t('Depois da primeira entrega, repetir a pergunta recebe texto. Só um novo pedido explícito de mídia permite outra entrega. Tentativas pendentes ou incertas não são duplicadas.')
        : t('Cada mídia é utilizada no máximo uma vez por conversa, mesmo se o cliente pedir novamente.')}</p>
    </div>}
    <p className="text-xs text-muted-foreground">{t('No máximo uma mídia obrigatória por resposta. Preferência por texto, atendimento humano e limites de envio prevalecem.')}</p>
  </div>;
}
