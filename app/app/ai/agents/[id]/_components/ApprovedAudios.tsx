'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { AUDIO_ACCEPT, AUDIO_MAX_BYTES, audioDescriptionSchema, type AudioPreview, type AudioStageOption } from '@/lib/ai/agents/approved-audios';
import { useT } from '@/hooks/i18n/useT';
import { AudioStagePicker } from './AudioStagePicker';
import { AudioDeliveryMode } from './AudioDeliveryMode';

/** Configuração operacional: aprovação não depende de republicar o prompt. */
export function ApprovedAudios({ agentId, readOnly }: { agentId: string; readOnly: boolean }) {
  const t = useT();
  const uid = useId();
  const [audios, setAudios] = useState<AudioPreview[]>([]);
  const [stages, setStages] = useState<AudioStageOption[]>([]);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [editStageIds, setEditStageIds] = useState<string[]>([]);
  const [editRestricted, setEditRestricted] = useState(false);
  const [required, setRequired] = useState(true);
  const [editRequired, setEditRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const preview = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  const [title, setTitle] = useState('');
  const [useWhen, setUseWhen] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editWhen, setEditWhen] = useState('');
  const endpoint = `/api/v1/ai/agents/${agentId}/audios`;

  const fetchAudios = useCallback(async (signal?: AbortSignal): Promise<{ audios: AudioPreview[]; stages: AudioStageOption[] }> => {
    const res = await fetch(endpoint, { signal, cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? 'Não foi possível carregar os áudios.');
    return { audios: json.data, stages: json.meta?.stage_options ?? [] };
  }, [endpoint]);
  const load = useCallback(async () => {
    try {
      const data = await fetchAudios(); setAudios(data.audios); setStages(data.stages);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar áudios.');
    } finally { setLoading(false); }
  }, [fetchAudios]);
  useEffect(() => {
    const abort = new AbortController();
    void fetchAudios(abort.signal).then(data => {
      if (!abort.signal.aborted) { setAudios(data.audios); setStages(data.stages); setError(''); }
    }).catch(err => {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Erro ao carregar áudios.');
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [fetchAudios]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', body: FormData | Record<string, unknown>) {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await fetch(endpoint, { method,
        ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? 'Não foi possível salvar o áudio.');
      if (method === 'POST') { setFile(null); setTitle(''); setUseWhen(''); setStageIds([]); setRestricted(false); setRequired(true); setFileKey(k => k + 1); }
      setEditing(null);
      setNotice(t('Alteração salva. Vale para os próximos turnos deste agente.'));
      setLoading(true); await load();
    } catch (err) { setError(err instanceof Error ? err.message : t('Erro ao salvar áudio.')); }
    finally { setBusy(false); }
  }

  function approve() {
    if (restricted && !stageIds.length) { setError(t('Selecione pelo menos uma etapa ou escolha Todas as etapas.')); return; }
    const description = audioDescriptionSchema.safeParse({ title, use_when: useWhen, stage_ids: restricted ? stageIds : [], required });
    if (!file || !description.success) { setError(t('Escolha uma gravação, informe um título e descreva quando usar (mínimo 10 caracteres).')); return; }
    if (file.size > AUDIO_MAX_BYTES || !file.size) { setError(t('Escolha um áudio válido de até 16 MB.')); return; }
    const form = new FormData();
    form.set('file', file); form.set('title', description.data.title); form.set('use_when', description.data.use_when);
    form.set('stage_ids', JSON.stringify(description.data.stage_ids));
    form.set('required', String(description.data.required));
    void mutate('POST', form);
  }
  function saveDescription(id: string) {
    if (editRestricted && !editStageIds.length) { setError(t('Selecione pelo menos uma etapa ou escolha Todas as etapas.')); return; }
    void mutate('PATCH', { audio_id: id, title: editTitle, use_when: editWhen, stage_ids: editRestricted ? editStageIds : [], required: editRequired });
  }
  const disabled = readOnly || busy || loading;
  return <Card className="space-y-4 p-4" data-testid="approved-audios">
    <div>
      <h3 className="text-sm font-medium">{t('Áudios pré-gravados')}</h3>
      <p className="text-xs text-muted-foreground">{t('Configure o envio obrigatório ou opcional, com texto curto de contexto antes do áudio. As alterações valem nos próximos turnos, sem republicar o agente.')}</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {loading ? <p className="text-sm">{t('Carregando áudios…')}</p> : audios.length === 0 && <p className="text-sm text-muted-foreground">{t('Nenhum áudio aprovado. O atendimento continua em texto.')}</p>}
    {audios.map(audio => <div key={audio.id} className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm">{audio.title}</strong>
        <div className="flex items-center gap-2">
          <span className="text-xs">{audio.enabled ? t('Ativo') : t('Desativado')}</span>
          <Switch checked={audio.enabled} aria-label={`${t('Ativar áudio')}: ${audio.title}`} disabled={disabled}
            onCheckedChange={enabled => void mutate('PATCH', { audio_id: audio.id, enabled })} />
        </div>
      </div>
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">{audio.use_when}</p>
      <p className="text-xs font-medium">{audio.required ? t('Envio obrigatório') : t('Envio opcional')}</p>
      <p className="text-xs text-muted-foreground">{t('Etapas permitidas')}: {audio.stage_ids?.length
        ? audio.stage_ids.map(id => { const s = stages.find(s => s.id === id); return s ? `${s.pipeline_name} › ${s.name}` : t('Etapa indisponível'); }).join(', ')
        : t('Todas as etapas')}</p>
      {editing === audio.id && <div className="space-y-2">
        <Label htmlFor={`${uid}-edit-title`}>{t('Editar título')}</Label>
        <Input id={`${uid}-edit-title`} value={editTitle} maxLength={120} onChange={e => setEditTitle(e.target.value)} disabled={disabled} />
        <Label htmlFor={`${uid}-edit-when`}>{t('Editar conteúdo e finalidade')}</Label>
        <Textarea id={`${uid}-edit-when`} value={editWhen} maxLength={1000} onChange={e => setEditWhen(e.target.value)} disabled={disabled} />
        <p className="text-xs text-muted-foreground">{t('Descreva o que está gravado. No modo opcional, informe também em quais situações o agente deve escolher o áudio.')}</p>
        <AudioStagePicker options={stages} ids={editStageIds} restricted={editRestricted} disabled={disabled} onChange={setEditStageIds} onRestricted={setEditRestricted} />
        <AudioDeliveryMode required={editRequired} disabled={disabled} onChange={setEditRequired} />
        <Button type="button" size="sm" disabled={disabled} onClick={() => saveDescription(audio.id)}>{t('Salvar áudio')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setEditing(null)}>{t('Cancelar edição')}</Button>
      </div>}
      {audio.preview_url ? <audio controls preload="none" src={audio.preview_url} className="w-full" aria-label={`${t('Ouvir')}: ${audio.title}`} />
        : <p className="text-xs text-destructive">{t('Prévia indisponível. Atualize a lista e tente novamente.')}</p>}
      {!readOnly && <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => { setEditing(audio.id); setEditTitle(audio.title); setEditWhen(audio.use_when); setEditStageIds(audio.stage_ids ?? []); setEditRestricted(!!audio.stage_ids?.length); setEditRequired(audio.required ?? false); }}>{t('Editar áudio')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled}
          onClick={() => void mutate('DELETE', { audio_id: audio.id })}>{t('Remover áudio')}</Button></div>}
    </div>)}
    <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => { setLoading(true); void load(); }}>{t('Atualizar lista')}</Button>
    {!readOnly && <div className="space-y-3 border-t pt-4">
      <p className="text-xs text-muted-foreground">{t('MP3, M4A, AAC, OGG, WAV ou WebM de áudio. Até 16 MB por arquivo e 20 gravações por agente. Ouça e confira o conteúdo antes de aprovar.')}</p>
      <div className="space-y-1"><Label htmlFor={`${uid}-file`}>{t('Gravação')}</Label>
        <Input key={fileKey} id={`${uid}-file`} type="file" accept={AUDIO_ACCEPT} disabled={disabled} onChange={e => setFile(e.target.files?.[0] ?? null)} /></div>
      {preview && <audio controls src={preview} className="w-full" aria-label={t('Ouvir gravação antes de aprovar')} />}
      <div className="space-y-1"><Label htmlFor={`${uid}-title`}>{t('Título do áudio')}</Label>
        <Input id={`${uid}-title`} value={title} maxLength={120} disabled={disabled} onChange={e => setTitle(e.target.value)} placeholder={t('Ex.: apresentação do serviço')} /></div>
      <div className="space-y-1"><Label htmlFor={`${uid}-when`}>{t('Conteúdo e finalidade do áudio')}</Label>
        <Textarea id={`${uid}-when`} value={useWhen} maxLength={1000} disabled={disabled} onChange={e => setUseWhen(e.target.value)}
          placeholder={t('Ex.: quando o cliente pedir uma demonstração ou orientações de suporte. Descreva o conteúdo da gravação.')} />
        <p className="text-xs text-muted-foreground">{t('Descreva o que está gravado. No modo opcional, informe também em quais situações o agente deve escolher o áudio.')}</p></div>
      <AudioStagePicker options={stages} ids={stageIds} restricted={restricted} disabled={disabled} onChange={setStageIds} onRestricted={setRestricted} />
      <AudioDeliveryMode required={required} disabled={disabled} onChange={setRequired} />
      <Button type="button" disabled={disabled || !file} onClick={approve}>{busy ? t('Preparando áudio…') : t('Aprovar áudio para o agente')}</Button>
    </div>}
  </Card>;
}
