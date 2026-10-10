'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/hooks/i18n/useT';

export function AudioRuleSettings({ trigger, condition, disabled, onTrigger, onCondition }: {
  trigger: 'first_contact' | 'topic'; condition: string; disabled: boolean;
  onTrigger: (value: 'first_contact' | 'topic') => void; onCondition: (value: string) => void;
}) {
  const t = useT(); const id = useId();
  return <div className="space-y-2 rounded-md border p-3">
    <Label htmlFor={`${id}-trigger`}>{t('Quando enviar este áudio')}</Label>
    <select id={`${id}-trigger`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={disabled}
      value={trigger} onChange={e => onTrigger(e.target.value as 'first_contact' | 'topic')}>
      <option value="topic">{t('Quando surgir o assunto correspondente')}</option>
      <option value="first_contact">{t('No primeiro atendimento da conversa')}</option>
    </select>
    {trigger === 'topic' && <>
      <Label htmlFor={`${id}-condition`}>{t('Condição e exemplos de perguntas')}</Label>
      <Textarea id={`${id}-condition`} value={condition} disabled={disabled} maxLength={1000}
        onChange={e => onCondition(e.target.value)}
        placeholder={t('Ex.: quando pedir como funciona o serviço. Exemplos: como funciona? O que consigo fazer? Não usar para dúvidas de preço.')} />
    </>}
    <p className="text-xs text-muted-foreground">{t('O assunto da mensagem atual determina o momento. As etapas apenas restringem onde usar. Se o agente avançar a etapa nesta interação, ela será conferida novamente antes do envio. Não é preciso o cliente repetir a pergunta.')}</p>
    <p className="text-xs text-muted-foreground">{t('Selecione também as etapas em que essa pergunta pode surgir. Se nenhuma etapa permitida for alcançada nesta interação, o atendimento segue por texto; o áudio não fica esperando outra pergunta.')}</p>
  </div>;
}
