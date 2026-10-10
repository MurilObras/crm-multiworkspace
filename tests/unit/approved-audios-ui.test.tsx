import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ApprovedAudios } from '@/app/app/ai/agents/[id]/_components/ApprovedAudios';
import { AttachmentPreviewDialog } from '@/components/inbox/composer/AttachmentPreviewDialog';

let entries: unknown[];
let calls: { method: string; body: unknown }[];
beforeEach(() => {
  entries = []; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET'; calls.push({ method, body: options?.body });
    if (method === 'POST') entries = [{ id: 'audio-1', title: 'Apresentação', use_when: 'Quando perguntar sobre o aplicativo', enabled: true, preview_url: 'https://signed.example/a.ogg' }];
    if (method === 'PATCH') entries = (entries as Record<string, unknown>[]).map(a => ({ ...a, enabled: false }));
    return new Response(JSON.stringify({ data: method === 'GET' ? entries : { saved: true } }));
  }));
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());
it('anexa, ouve antes de aprovar, salva e permite retirar a aprovação', async () => {
  const user = userEvent.setup();
  render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
  await screen.findByText('Nenhum áudio aprovado. O atendimento continua em texto.');
  await user.upload(screen.getByLabelText('Gravação'), new File(['audio'], 'apresentacao.mp3', { type: 'audio/mpeg' }));
  expect(screen.getByLabelText('Ouvir gravação antes de aprovar')).toHaveAttribute('src', 'blob:test');
  await user.type(screen.getByLabelText('Título do áudio'), 'Apresentação');
  await user.type(screen.getByLabelText('Quando o agente deve usar'), 'Quando perguntar sobre o aplicativo');
  await user.click(screen.getByRole('button', { name: 'Aprovar áudio para o agente' }));
  await screen.findByText('Apresentação');
  const body = calls.find(c => c.method === 'POST')!.body as FormData;
  expect(body.get('title')).toBe('Apresentação'); expect(body.get('file')).toBeInstanceOf(File);
  expect(screen.getByLabelText('Ouvir: Apresentação')).toHaveAttribute('src', 'https://signed.example/a.ogg');
  await user.click(screen.getByRole('switch', { name: 'Ativar áudio: Apresentação' }));
  await screen.findByText('Desativado');
  expect(JSON.parse(calls.find(c => c.method === 'PATCH')!.body as string)).toEqual({ audio_id: 'audio-1', enabled: false });
});
it('expõe falha de leitura e não oferece escrita a quem só pode consultar', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Sem permissão.' } }), { status: 403 }));
  render(<ApprovedAudios agentId="agent-1" readOnly />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sem permissão.');
  expect(screen.queryByLabelText('Gravação')).toBeNull();
  expect(screen.queryByRole('button', { name: /aprovar/i })).toBeNull();
});
it('preview de áudio no inbox permite ouvir e não promete legenda', async () => {
  const send = vi.fn();
  render(<AttachmentPreviewDialog file={new File(['x'], 'audio.mp3', { type: 'audio/mpeg' })} sending={false} onCancel={vi.fn()} onSend={send} />);
  expect(screen.getByLabelText('Ouvir áudio antes de enviar')).toBeVisible();
  expect(screen.queryByLabelText('Legenda')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /^Enviar$/ }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(''));
});
