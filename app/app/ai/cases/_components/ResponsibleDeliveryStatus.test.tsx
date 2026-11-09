import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api/client';
import { ResponsibleDeliveryStatus } from './ResponsibleDeliveryStatus';
vi.mock('@/hooks/i18n/useT', () => ({ useT: () => (s: string) => s }));
vi.mock('@/lib/api/client', () => ({ apiClient: { get: vi.fn() } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { vi.mocked(apiClient.get).mockReset(); });

describe('atualização das entregas', () => {
  it.each([
    ['sent', 'Enviado ao WhatsApp'],
    ['delivered', 'Entregue pelo WhatsApp'],
    ['read', 'Lido no WhatsApp'],
    [null, 'Sem confirmação de entrega'],
  ])('mostra o recibo %s sem confundi-lo com a resolução da consulta', async (messageStatus, label) => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: {
      requests: [{ id: 'request', kind: 'consultation', status: 'pending', answered_by: null }],
      deliveries: [{ id: 'delivery', purpose: 'notification', status: 'sent',
        responsible_name: 'Coordenador', format: 'audio', message_status: messageStatus }],
    } });
    render(<ResponsibleDeliveryStatus caseId="synthetic-case" />);
    const item = await screen.findByRole('listitem');
    expect(item).toHaveTextContent(label);
    expect(item).toHaveTextContent('áudio');
    expect(screen.getByText('Consulta ao responsável: Aguardando')).toBeVisible();
    expect(screen.queryByText(/Entregue ao cliente/)).not.toBeInTheDocument();
  });

  it('não apresenta o envio preparado ou incerto como entregue', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: {
      requests: [{ id: 'request', kind: 'consultation', status: 'pending', answered_by: null }],
      deliveries: [{ id: 'delivery', purpose: 'answer', status: 'uncertain',
        responsible_name: null, format: 'text', message_status: 'sending' }],
    } });
    render(<ResponsibleDeliveryStatus caseId="synthetic-case" />);
    const item = await screen.findByRole('listitem');
    expect(item).toHaveTextContent('Entrega incerta');
    expect(item).toHaveTextContent('Sem confirmação de entrega');
    expect(item).not.toHaveTextContent('Entregue pelo WhatsApp');
  });

  it('não sobrepõe consultas lentas e cancela a leitura ao fechar o caso', async () => {
    vi.useFakeTimers();
    let finish!: (value: { data: { requests: []; deliveries: [] } }) => void;
    vi.mocked(apiClient.get).mockReturnValueOnce(new Promise(r => { finish = r; }));
    const page = render(<ResponsibleDeliveryStatus caseId="synthetic-case" />);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    const options = vi.mocked(apiClient.get).mock.calls[0]![1]!;
    expect(options.signal?.aborted).toBe(false);
    await act(async () => { finish({ data: { requests: [], deliveries: [] } }); });
    page.unmount();
    expect(options.signal?.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
});
