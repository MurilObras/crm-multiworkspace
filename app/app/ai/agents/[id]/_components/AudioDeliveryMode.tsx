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
      ? t('Ligado: o CRM envia este áudio na primeira resposta do agente em uma etapa permitida, sem depender da escolha da IA.')
      : t('Desligado: o agente pode escolher este áudio quando for útil, ou responder apenas por texto.')}</p>
    <p className="text-xs text-muted-foreground">{t('Cada gravação é enviada no máximo uma vez por conversa. No máximo um áudio obrigatório por resposta; os demais aguardam próximas respostas. Pedidos de só texto, atendimento humano e limites de envio são respeitados.')}</p>
  </div>;
}
