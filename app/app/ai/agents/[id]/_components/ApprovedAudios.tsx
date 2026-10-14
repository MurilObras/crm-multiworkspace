'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { audioDescriptionSchema, type AudioStageOption } from '@/lib/ai/agents/approved-audios';
import { MEDIA_ACCEPT as AUDIO_ACCEPT, MEDIA_MAX_BYTES as AUDIO_MAX_BYTES, mediaKind, type MediaPreview as AudioPreview } from '@/lib/ai/agents/approved-media';
import { useT } from '@/hooks/i18n/useT';
import { AudioStagePicker } from './AudioStagePicker';
import { AudioDeliveryMode } from './AudioDeliveryMode';
import { AudioRuleSettings } from './AudioRuleSettings';

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
  const [allowRepeat, setAllowRepeat] = useState(true);
  const [editAllowRepeat, setEditAllowRepeat] = useState(false);
  const [trigger, setTrigger] = useState<'first_contact' | 'topic'>('topic');
  const [sendWhen, setSendWhen] = useState('');
  const [editTrigger, setEditTrigger] = useState<'first_contact' | 'topic'>('topic');
  const [editSendWhen, setEditSendWhen] = useState('');
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
  const endpoint = `/api/v1/ai/agents/${agentId}/media`;

  const fetchAudios = useCallback(async (signal?: AbortSignal): Promise<{ audios: AudioPreview[]; stages: AudioStageOption[] }> => {
    const res = await fetch(endpoint, { signal, cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? 'Não foi possível carregar as mídias.');
    return { audios: json.data, stages: json.meta?.stage_options ?? [] };
  }, [endpoint]);
  const load = useCallback(async () => {
    try {
      const data = await fetchAudios(); setAudios(data.audios); setStages(data.stages);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar mídias.');
    } finally { setLoading(false); }
  }, [fetchAudios]);
  useEffect(() => {
    const abort = new AbortController();
    void fetchAudios(abort.signal).then(data => {
      if (!abort.signal.aborted) { setAudios(data.audios); setStages(data.stages); setError(''); }
    }).catch(err => {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Erro ao carregar mídias.');
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
      if (!res.ok) throw new Error(json.error?.message ?? 'Não foi possível salvar a mídia.');
      if (method === 'POST') { setFile(null); setTitle(''); setUseWhen(''); setStageIds([]); setRestricted(false); setRequired(true); setAllowRepeat(true); setTrigger('topic'); setSendWhen(''); setFileKey(k => k + 1); }
      setEditing(null);
      setNotice(t('Alteração salva. Vale para os próximos turnos deste agente.'));
      setLoading(true); await load();
    } catch (err) { setError(err instanceof Error ? err.message : t('Erro ao salvar mídia.')); }
    finally { setBusy(false); }
  }

  function approve() {
    if (restricted && !stageIds.length) { setError(t('Selecione pelo menos uma etapa ou escolha Todas as etapas.')); return; }
    if (trigger === 'topic' && sendWhen.trim().length < 10) { setError(t('Descreva a condição de envio e exemplos (mínimo 10 caracteres).')); return; }
    const description = audioDescriptionSchema.safeParse({ title, use_when: useWhen, stage_ids: restricted ? stageIds : [], required, trigger_type: trigger, send_when: sendWhen });
    if (!file || !description.success) { setError(t('Escolha um arquivo, informe um título e descreva seu conteúdo (mínimo 10 caracteres).')); return; }
    if (file.size > AUDIO_MAX_BYTES || !file.size) { setError(t('Escolha um arquivo válido de até 16 MB.')); return; }
    const form = new FormData();
    form.set('file', file); form.set('title', description.data.title); form.set('use_when', description.data.use_when);
    form.set('stage_ids', JSON.stringify(description.data.stage_ids));
    form.set('required', String(description.data.required));
    form.set('allow_requested_repeat', String(allowRepeat));
    form.set('trigger_type', description.data.trigger_type); form.set('send_when', description.data.send_when);
    void mutate('POST', form);
  }
  function saveDescription(id: string) {
    if (editRestricted && !editStageIds.length) { setError(t('Selecione pelo menos uma etapa ou escolha Todas as etapas.')); return; }
    if (editTrigger === 'topic' && editSendWhen.trim().length < 10) { setError(t('Descreva a condição de envio e exemplos (mínimo 10 caracteres).')); return; }
    void mutate('PATCH', { audio_id: id, title: editTitle, use_when: editWhen, stage_ids: editRestricted ? editStageIds : [], required: editRequired, allow_requested_repeat: editAllowRepeat, trigger_type: editTrigger, send_when: editSendWhen });
  }
  const disabled = readOnly || busy || loading;
  return <Card className="space-y-4 p-4" data-testid="approved-audios">
    <div>
      <h3 className="text-sm font-medium">{t('Mídias aprovadas')}</h3>
      <p className="text-xs text-muted-foreground">{t('Cadastre áudio, foto ou vídeo e configure assunto, etapas, obrigatoriedade e reenvio a pedido. Vale nos próximos turnos, sem republicar o agente.')}</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {loading ? <p className="text-sm">{t('Carregando mídias…')}</p> : audios.length === 0 && <p className="text-sm text-muted-foreground">{t('Nenhuma mídia aprovada. O atendimento continua em texto.')}</p>}
    {audios.map(audio => <div key={audio.id} className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm">{audio.title}</strong>
        <div className="flex items-center gap-2">
          <span className="text-xs">{audio.enabled ? t('Ativo') : t('Desativado')}</span>
          <Switch checked={audio.enabled} aria-label={`${t('Ativar mídia')}: ${audio.title}`} disabled={disabled}
            onCheckedChange={enabled => void mutate('PATCH', { audio_id: audio.id, enabled })} />
        </div>
      </div>
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">{audio.use_when}</p>
      <p className="text-xs font-medium">{audio.required ? t('Envio obrigatório') : t('Envio opcional')}</p>
      <p className="text-xs text-muted-foreground">{audio.allow_requested_repeat
        ? t('Reenvio: somente a pedido explícito') : t('Reenvio: desativado')}</p>
      <p className="text-xs text-muted-foreground">{t('Quando enviar esta mídia')}: {audio.trigger_type === 'first_contact'
        ? t('No primeiro atendimento da conversa') : (audio.send_when || audio.use_when)}</p>
      <p className="text-xs text-muted-foreground">{t('Etapas permitidas')}: {audio.stage_ids?.length
        ? audio.stage_ids.map(id => { const s = stages.find(s => s.id === id); return s ? `${s.pipeline_name} › ${s.name}` : t('Etapa indisponível'); }).join(', ')
        : t('Todas as etapas')}</p>
      {editing === audio.id && <div className="space-y-2">
        <Label htmlFor={`${uid}-edit-title`}>{t('Editar título')}</Label>
        <Input id={`${uid}-edit-title`} value={editTitle} maxLength={120} onChange={e => setEditTitle(e.target.value)} disabled={disabled} />
        <Label htmlFor={`${uid}-edit-when`}>{t('Editar conteúdo e finalidade')}</Label>
        <Textarea id={`${uid}-edit-when`} value={editWhen} maxLength={1000} onChange={e => setEditWhen(e.target.value)} disabled={disabled} />
        <p className="text-xs text-muted-foreground">{t('Descreva o conteúdo. Configure separadamente a condição que determina quando enviar.')}</p>
        <AudioRuleSettings trigger={editTrigger} condition={editSendWhen} disabled={disabled} onTrigger={setEditTrigger} onCondition={setEditSendWhen} />
        <AudioStagePicker options={stages} ids={editStageIds} restricted={editRestricted} disabled={disabled} onChange={setEditStageIds} onRestricted={setEditRestricted} />
        <AudioDeliveryMode required={editRequired} disabled={disabled} onChange={setEditRequired} allowRepeat={editAllowRepeat} onRepeat={setEditAllowRepeat} />
        <Button type="button" size="sm" disabled={disabled} onClick={() => saveDescription(audio.id)}>{t('Salvar mídia')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setEditing(null)}>{t('Cancelar edição')}</Button>
      </div>}
      {audio.preview_url ? <MediaPreview kind={mediaKind(audio)} src={audio.preview_url} title={audio.title} />
        : <p className="text-xs text-destructive">{t('Prévia indisponível. Atualize a lista e tente novamente.')}</p>}
      {!readOnly && <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => { setEditing(audio.id); setEditTitle(audio.title); setEditWhen(audio.use_when); setEditStageIds(audio.stage_ids ?? []); setEditRestricted(!!audio.stage_ids?.length); setEditRequired(audio.required ?? false); setEditAllowRepeat(audio.allow_requested_repeat ?? false); setEditTrigger(audio.trigger_type ?? 'topic'); setEditSendWhen(audio.send_when || audio.use_when); }}>{t('Editar mídia')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled}
          onClick={() => void mutate('DELETE', { audio_id: audio.id })}>{t('Remover mídia')}</Button></div>}
    </div>)}
    <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => { setLoading(true); void load(); }}>{t('Atualizar lista')}</Button>
    {!readOnly && <div className="space-y-3 border-t pt-4">
      <p className="text-xs text-muted-foreground">{t('Áudio MP3/M4A/AAC/OGG/WAV/WebM, foto JPG/PNG ou vídeo MP4. Até 16 MB por arquivo e 20 mídias por agente. Confira a prévia e descreva o conteúdo antes de aprovar.')}</p>
      <div className="space-y-1"><Label htmlFor={`${uid}-file`}>{t('Arquivo')}</Label>
        <Input key={fileKey} id={`${uid}-file`} type="file" accept={AUDIO_ACCEPT} disabled={disabled} onChange={e => setFile(e.target.files?.[0] ?? null)} /></div>
      {preview && <MediaPreview kind={file?.type.startsWith('image/') ? 'image' : file?.type.startsWith('video/') ? 'video' : 'audio'} src={preview} title={t('Conferir arquivo antes de aprovar')} />}
      <div className="space-y-1"><Label htmlFor={`${uid}-title`}>{t('Título da mídia')}</Label>
        <Input id={`${uid}-title`} value={title} maxLength={120} disabled={disabled} onChange={e => setTitle(e.target.value)} placeholder={t('Ex.: apresentação do serviço')} /></div>
      <div className="space-y-1"><Label htmlFor={`${uid}-when`}>{t('Conteúdo e finalidade da mídia')}</Label>
        <Textarea id={`${uid}-when`} value={useWhen} maxLength={1000} disabled={disabled} onChange={e => setUseWhen(e.target.value)}
          placeholder={t('Ex.: quando o cliente pedir uma demonstração ou orientações de suporte. Descreva o conteúdo da gravação.')} />
        <p className="text-xs text-muted-foreground">{t('Descreva o conteúdo. Configure separadamente a condição que determina quando enviar.')}</p></div>
      <AudioRuleSettings trigger={trigger} condition={sendWhen} disabled={disabled} onTrigger={setTrigger} onCondition={setSendWhen} />
      <AudioStagePicker options={stages} ids={stageIds} restricted={restricted} disabled={disabled} onChange={setStageIds} onRestricted={setRestricted} />
      <AudioDeliveryMode required={required} disabled={disabled} onChange={setRequired} allowRepeat={allowRepeat} onRepeat={setAllowRepeat} />
      <Button type="button" disabled={disabled || !file} onClick={approve}>{busy ? t('Preparando mídia…') : t('Aprovar mídia para o agente')}</Button>
    </div>}
  </Card>;
}

function MediaPreview({ kind, src, title }: { kind: 'audio' | 'image' | 'video'; src: string; title: string }) {
  if (kind === 'video') return <video controls preload="metadata" playsInline src={src} className="max-h-72 w-full" aria-label={title} />;
  if (kind === 'image') {
    // URLs privadas assinadas/blob: não encaminhar pela otimização pública de imagens.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={title} className="max-h-72 max-w-full object-contain" />;
  }
  return <audio controls preload="none" src={src} className="w-full" aria-label={title} />;
}
