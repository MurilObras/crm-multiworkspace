'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCases } from '@/hooks/ai/useCases';
import { useT } from '@/hooks/i18n/useT';
import { apiClient } from '@/lib/api/client';

type Progress = { status: 'pending' | 'confirmed' | 'applied' | 'partial' | 'cancelled'; case_id: string; reason: string | null };
const REASON_LABEL: Record<string, string> = {
  human_control_changed: 'Uma decisão mais recente da equipe foi preservada.',
  pending_consultation: 'Há outra consulta aguardando resposta.',
  contact_blocked: 'O contato está bloqueado ou indisponível para o automático.',
  conversation_closed: 'A conversa está encerrada.',
  conversation_changed: 'Os dados da conversa mudaram. Confira o atendimento.',
  other_human_conversation: 'A equipe está atendendo este contato em outra conversa.',
  actor_access_revoked: 'O acesso do atendente mudou. Solicite conferência à equipe.',
  case_already_closed: 'Esta consulta já foi tratada por outro caminho.',
  message_not_confirmed: 'A entrega da resposta não pôde ser confirmada.',
  send_failed_before_transport: 'O envio falhou antes de sair. A consulta permanece pendente.',
  responsible_answer_in_flight: 'Uma resposta do responsável está sendo conferida.',
};

function ResolutionProgress({ messageId }: { messageId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const attempts = useRef(0);
  const [exhausted, setExhausted] = useState(false);
  const refreshed = useRef(false);
  const progress = useQuery({
    queryKey: ['case-resolution', messageId],
    queryFn: async ({ signal }) => {
      attempts.current++;
      if (attempts.current >= 12) setExhausted(true);
      return (await apiClient.get<{ data: Progress | null }>(`/api/v1/messages/${messageId}/case-resolution`,
        { signal, maxAttempts: 1 })).data;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => ['applied', 'partial', 'cancelled'].includes(query.state.data?.status ?? '') || attempts.current >= 12 ? false : 5_000,
  });
  useEffect(() => {
    if (!progress.data || !['applied', 'partial', 'cancelled'].includes(progress.data.status) || refreshed.current) return;
    refreshed.current = true;
    void qc.invalidateQueries({ queryKey: ['ai-cases'] });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  }, [progress.data, qc]);
  const status = progress.data?.status;
  const label = progress.isError ? 'Não foi possível conferir a resolução. Consulte o caso antes de reenviar.'
    : status === 'applied' ? 'Consulta concluída e automático liberado.'
      : status === 'partial' ? 'Envio confirmado; atendimento automático ainda impedido.'
        : status === 'cancelled' ? 'Resolução não aplicada. Confira a consulta.'
          : status === 'confirmed' ? 'Envio confirmado; concluindo a consulta.'
            : exhausted ? 'Ainda aguardando confirmação. Confira a consulta; não reenvie automaticamente.'
              : 'Aguardando confirmação do envio; a consulta permanece pendente.';
  const reason = progress.data?.reason;
  return <p role="status" className="mb-2 break-words text-xs text-muted-foreground">{t(label)}{reason ? ` ${t(REASON_LABEL[reason] ?? 'Confira os detalhes da consulta.')}` : ''}</p>;
}

interface Props {
  conversationId: string;
  /** undefined = desmarcada; null = marcada sem escolha entre várias consultas. */
  value: string | null | undefined;
  onChange: (id: string | null | undefined) => void;
  disabled?: boolean;
  messageId?: string | null;
}

export function PendingCaseResolution({ conversationId, value, onChange, disabled, messageId }: Props) {
  const t = useT();
  const query = useCases('open', conversationId);
  const cases = (query.data?.cases ?? []).filter(item => item.status === 'awaiting_human' && item.conversation_id === conversationId);
  const agentName = query.data?.agent_name;
  const messageIds = [...new Set([...(query.data?.resolution_message_ids ?? []), ...(messageId ? [messageId] : [])])].slice(-6);
  return <>
    {messageIds.map(id => <ResolutionProgress key={id} messageId={id} />)}
    {query.isError && <p role="alert" className="mb-2 text-xs">{t('Não foi possível consultar as pendências desta conversa.')}</p>}
    {cases.length > 0 && <fieldset disabled={disabled} className="mb-2 min-w-0 rounded-md border border-border p-2 text-xs">
      <p className="mb-2 text-muted-foreground">{t('Aguardando resolução da consulta.')} <Link className="underline" href={`/app/ai/cases?case_id=${encodeURIComponent(cases[0]!.id)}`}>{t('Abrir consulta')}</Link></p>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={value !== undefined}
          onChange={event => onChange(event.target.checked ? cases.length === 1 ? cases[0]!.id : null : undefined)} />
        <span>{t('Esta resposta resolve a consulta e libera o')} {agentName || t('atendimento automático')}</span>
      </label>
      {value !== undefined && <div className="mt-2 space-y-1">
        <label className="block">{t('Consulta resolvida por esta resposta')}
          <select aria-label={t('Consulta resolvida por esta resposta')} className="mt-1 block w-full min-w-0 rounded-md border border-input bg-background p-2"
            value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
            <option value="">{t('Selecione uma consulta')}</option>
            {cases.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
        <p className="text-muted-foreground">{t('Válido para esta resposta em texto ou áudio. A liberação depende da confirmação do envio e de não haver outro bloqueio.')}</p>
      </div>}
    </fieldset>}
  </>;
}
