'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/hooks/i18n/useT';

export function AudioDeliveryMode({ required, disabled, onChange }: {
  required: boolean; disabled: boolean; onChange: (required: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  return <div className="space-y-2 rounded-md border p-3">
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id}>{t('Envio obrigatório')}</Label>
      <Switch id={id} checked={required} disabled={disabled} onCheckedChange={onChange} aria-describedby={`${id}-help`} />
    </div>
    <p id={`${id}-help`} className="text-xs text-muted-foreground">{required
      ? t('Ligado: quando a condição configurada for identificada, o CRM envia o áudio nessa mesma interação, dentro das etapas permitidas. Estar na etapa não basta.')
      : t('Desligado: o agente pode escolher este áudio quando a condição for pertinente, ou responder apenas por texto.')}</p>
    <p className="text-xs text-muted-foreground">{t('Cada gravação é enviada no máximo uma vez por conversa. No máximo um áudio obrigatório por resposta; outros áudios só serão considerados quando surgir o assunto correspondente. Pedidos de só texto, atendimento humano e limites de envio são respeitados.')}</p>
  </div>;
}
