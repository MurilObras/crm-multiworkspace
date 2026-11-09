import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api/client';
import { Composer } from '@/components/inbox/Composer';

vi.mock('@/lib/api/client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/i18n/useT', () => ({ useT: () => (s: string) => s }));
vi.mock('@/hooks/inbox/useMessageTemplates', () => ({ useMessageTemplates: () => ({ data: [] }) }));
vi.mock('@/hooks/inbox/useDraftReply', () => ({ useDraftReply: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/components/feedback/ApiErrorToast', () => ({ showApiError: vi.fn() }));
vi.mock('@/hooks/inbox/useUploadMedia', () => ({ useUploadMedia: () => ({ isPending: false,
  mutateAsync: async () => ({ storage_path: 'synthetic/audio.ogg', media_mime: 'audio/ogg', media_size_bytes: 5, kind: 'audio' }) }) }));

const CASE = '10000000-0000-4000-8000-000000000001';
const OTHER_CASE = '10000000-0000-4000-8000-000000000002';
let cases = [{ id: CASE, title: 'Condição comercial', status: 'awaiting_human', conversation_id: 'conversation-a' }];
let progress = { status: 'pending', reason: null as string | null, case_id: CASE };
let historyIds: string[] = [];

function renderComposer(conversationId = 'conversation-a', extra: { blockedReason?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrap = (id: string) => <QueryClientProvider client={qc}><Composer conversationId={id} {...extra} /></QueryClientProvider>;
  const view = render(wrap(conversationId));
  return { ...view, changeConversation: (id: string) => view.rerender(wrap(id)) };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.mocked(apiClient.get).mockReset(); vi.mocked(apiClient.post).mockReset();
  cases = [{ id: CASE, title: 'Condição comercial', status: 'awaiting_human', conversation_id: 'conversation-a' }];
  progress = { status: 'pending', reason: null, case_id: CASE };
  historyIds = [];
  vi.mocked(apiClient.get).mockImplementation(async (url) => {
    if (url.includes('/case-resolution')) return { data: progress };
    if (url.startsWith('/api/v1/ai/cases?')) return { data: { cases, open_count: cases.length, agent_name: 'Júnior', resolution_message_ids: historyIds } };
    return { data: [] };
  });
  vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'message-1' } });
});

describe('resolução explícita pelo Inbox', () => {
  it('começa desmarcada; uma resposta comum não resolve a consulta', async () => {
    renderComposer();
    expect(await screen.findByRole('checkbox', { name: /Esta resposta resolve a consulta e libera o Júnior/ })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Vou verificar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).not.toHaveProperty('resolve_case_id');
  });

  it('exige escolher uma entre várias consultas e vincula o Enter somente ao envio atual', async () => {
    cases.push({ id: OTHER_CASE, title: 'Horário', status: 'awaiting_human', conversation_id: 'conversation-a' });
    renderComposer();
    fireEvent.click(await screen.findByRole('checkbox'));
    const input = screen.getByLabelText('Mensagem');
    fireEvent.change(input, { target: { value: 'Condição confirmada' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(apiClient.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Consulta resolvida por esta resposta'), { target: { value: OTHER_CASE } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({ resolve_case_id: OTHER_CASE, type: 'text' });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(await screen.findByText(/Aguardando confirmação do envio/)).toBeVisible();
    expect(screen.queryByText(/Consulta concluída e automático liberado/)).not.toBeInTheDocument();
  });

  it('descarta a intenção ao trocar para nota interna ou outra conversa', async () => {
    const view = renderComposer();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    view.changeConversation('conversation-b');
    await act(async () => {});
    view.changeConversation('conversation-a');
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
  });

  it('mostra confirmação parcial sem afirmar liberação quando ainda existe bloqueio', async () => {
    progress = { status: 'partial', reason: 'pending_consultation', case_id: CASE };
    renderComposer(); fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Horário confirmado' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(/Há outra consulta aguardando resposta/)).toBeVisible();
    expect(screen.queryByText(/Consulta concluída e automático liberado/)).not.toBeInTheDocument();
  });

  it('só anuncia conclusão e liberação após confirmação aplicada no servidor', async () => {
    progress = { status: 'applied', reason: null, case_id: CASE };
    renderComposer(); fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Condição aprovada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(/Consulta concluída e automático liberado/)).toBeVisible();
    expect(vi.mocked(apiClient.post).mock.calls[0]![2]).toMatchObject({ idempotencyKey: expect.any(String) });
  });

  it('uma resposta em áudio conserva a consulta escolhida durante upload sem marcar a próxima resposta', async () => {
    class Recorder {
      static isTypeSupported = () => true;
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      state = 'inactive';
      mimeType = 'audio/ogg';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic']) }); this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) } });
    renderComposer(); fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Gravar áudio' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar áudio' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({ type: 'audio', resolve_case_id: CASE, media_storage_path: 'synthetic/audio.ogg' });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(await screen.findByText(/Aguardando confirmação do envio/)).toBeVisible();
  });

  it('não permite indicar liberação para contato bloqueado', async () => {
    renderComposer('conversation-a', { blockedReason: 'Contato bloqueado' });
    expect(screen.getByText('Contato bloqueado')).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).not.toBeInTheDocument();
  });

  it('recupera a conferência pendente do histórico após reabrir a conversa', async () => {
    historyIds = ['historic-message'];
    renderComposer();
    expect(await screen.findByText(/Aguardando confirmação do envio/)).toBeVisible();
    expect(vi.mocked(apiClient.get).mock.calls.some(([url]) => url === '/api/v1/messages/historic-message/case-resolution')).toBe(true);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('não restaura o texto da conversa anterior quando um envio falha depois da troca', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(apiClient.post).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const view = renderComposer();
    await screen.findByRole('checkbox');
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Resposta da conversa anterior' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    view.changeConversation('conversation-b');
    await act(async () => { reject(new Error('Falha de transporte sintética')); });
    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
  });

  it('bloqueia enviar gravação iniciada antes de marcar uma consulta sem escolher qual, mantendo cancelar disponível', async () => {
    class Recorder {
      static isTypeSupported = () => true;
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      state = 'inactive'; mimeType = 'audio/ogg';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic']) }); this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) } });
    cases.push({ id: OTHER_CASE, title: 'Horário', status: 'awaiting_human', conversation_id: 'conversation-a' });
    renderComposer(); await screen.findByRole('checkbox');
    fireEvent.click(screen.getByRole('button', { name: 'Gravar áudio' }));
    await screen.findByRole('button', { name: 'Enviar áudio' });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Enviar áudio' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar gravação' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar áudio' }));
    expect(apiClient.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar gravação' }));
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
