'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { useT } from '@/hooks/i18n/useT';
import type { AudioStageOption } from '@/lib/ai/agents/approved-audios';

export function AudioStagePicker({ options, ids, restricted, disabled, onChange, onRestricted }: {
  options: AudioStageOption[]; ids: string[]; restricted: boolean; disabled: boolean;
  onChange: (ids: string[]) => void; onRestricted: (value: boolean) => void;
}) {
  const t = useT();
  const uid = useId();
  const missing = ids.filter(id => !options.some(s => s.id === id));
  return <div className="space-y-2">
    <Label htmlFor={`${uid}-scope`}>{t('Onde este áudio pode ser usado')}</Label>
    <select id={`${uid}-scope`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={disabled}
      value={restricted ? 'selected' : 'all'} onChange={e => onRestricted(e.target.value === 'selected')}>
      <option value="all">{t('Todas as etapas')}</option>
      <option value="selected">{t('Etapas específicas')}</option>
    </select>
    <p className="text-xs text-muted-foreground">{t('Escolha etapas de qualquer funil deste workspace, inclusive atendimento e suporte. O modo de envio define se o áudio é obrigatório ou opcional nessas etapas.')}</p>
    {restricted && <fieldset disabled={disabled} className="max-h-44 space-y-2 overflow-y-auto rounded-md border p-3">
      <legend className="px-1 text-xs">{t('Etapas permitidas')}</legend>
      {!options.length && <p className="text-xs">{t('Nenhuma etapa ativa disponível. Configure os funis ou atualize a lista.')}</p>}
      {options.map(s => <label key={s.id} className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={ids.includes(s.id)} onChange={e => onChange(e.target.checked
          ? [...ids, s.id] : ids.filter(id => id !== s.id))} />
        <span className="break-words">{s.pipeline_name} › {s.name}</span>
      </label>)}
      {missing.map(id => <label key={id} className="flex items-start gap-2 text-xs text-destructive">
        <input type="checkbox" checked onChange={() => onChange(ids.filter(value => value !== id))} />
        {t('Etapa indisponível. Remova este vínculo e selecione uma etapa ativa.')}
      </label>)}
    </fieldset>}
  </div>;
}
