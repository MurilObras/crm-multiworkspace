import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ApprovedAudios } from '@/app/app/ai/agents/[id]/_components/ApprovedAudios';
import { AttachmentPreviewDialog } from '@/components/inbox/composer/AttachmentPreviewDialog';
import { IdiomaProvider } from '@/lib/i18n/IdiomaProvider';

let entries: unknown[];
let calls: { method: string; body: unknown }[];
const stage = { id: '10000000-0000-4000-8000-000000000072', name: 'Orientação', pipeline_id: 'p', pipeline_name: 'Suporte' };
beforeEach(() => {
  entries = []; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET'; calls.push({ method, body: options?.body });
    if (method === 'POST') entries = [{ id: 'audio-1', title: 'Apresentação', use_when: 'Quando perguntar sobre o aplicativo', enabled: true, trigger_type: (options!.body as FormData).get('trigger_type'), send_when: (options!.body as FormData).get('send_when'), required: (options!.body as FormData).get('required') === 'true', stage_ids: JSON.parse((options!.body as FormData).get('stage_ids') as string), preview_url: 'https://signed.example/a.ogg' }];
    if (method === 'PATCH') entries = (entries as Record<string, unknown>[]).map(a => ({ ...a, ...JSON.parse(options!.body as string) }));
    return new Response(JSON.stringify({ data: method === 'GET' ? entries : { saved: true }, meta: { stage_options: [stage] } }));
  }));
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn();
});
it('seleciona etapa de suporte no cadastro e altera para todas as etapas pela tela', async () => {
  const user = userEvent.setup(); render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
  await screen.findByText('Nenhuma mídia aprovada. O atendimento continua em texto.');
  expect(screen.getByRole('switch', { name: 'Envio obrigatório' })).toBeChecked();
  await user.upload(screen.getByLabelText('Arquivo'), new File(['audio'], 'apresentacao.mp3', { type: 'audio/mpeg' }));
  await user.type(screen.getByLabelText('Título da mídia'), 'Apresentação');
  await user.type(screen.getByLabelText('Conteúdo e finalidade da mídia'), 'Quando precisar de orientação');
  await user.type(screen.getByLabelText('Condição e exemplos de perguntas'), 'Quando pedir como funciona o serviço');
  await user.selectOptions(screen.getByLabelText('Onde esta mídia pode ser usada'), 'selected');
  await user.click(screen.getByRole('button', { name: 'Aprovar mídia para o agente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Selecione pelo menos uma etapa');
  expect(calls.some(c => c.method === 'POST')).toBe(false);
  await user.click(screen.getByRole('checkbox', { name: 'Suporte › Orientação' }));
  await user.click(screen.getByRole('button', { name: 'Aprovar mídia para o agente' }));
  await screen.findByText('Apresentação');
  expect((calls.find(c => c.method === 'POST')!.body as FormData).get('stage_ids')).toBe(JSON.stringify([stage.id]));
  expect(screen.getByText('Etapas permitidas: Suporte › Orientação')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Editar mídia' }));
  const selectors = screen.getAllByLabelText('Onde esta mídia pode ser usada');
  await user.selectOptions(selectors[0]!, 'all');
  await user.click(screen.getAllByRole('switch', { name: 'Envio obrigatório' })[0]!);
  expect(screen.getByText(/Desligado: o agente pode escolher/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Salvar mídia' }));
  await waitFor(() => expect(screen.getByText('Etapas permitidas: Todas as etapas')).toBeVisible());
  expect(JSON.parse(calls.find(c => c.method === 'PATCH')!.body as string).stage_ids).toEqual([]);
  expect(JSON.parse(calls.find(c => c.method === 'PATCH')!.body as string).required).toBe(false);
  expect(screen.getByText('Envio opcional', { exact: true })).toBeVisible();
});
afterEach(() => vi.unstubAllGlobals());
it('traduz o erro operacional e a referência para espanhol', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: {
    message: 'Não foi possível confirmar o salvamento. Atualize a lista antes de tentar novamente.',
  } }), { status: 503, headers: { 'X-Request-Id': '10000000-0000-4000-8000-000000000099' } })));
  render(<IdiomaProvider locale="es"><ApprovedAudios agentId="agent-1" readOnly={false} /></IdiomaProvider>);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('No se pudo confirmar el guardado.');
  expect(alert).toHaveTextContent('Referencia: 10000000-0000-4000-8000-000000000099');
});
it.each([503, 409, 422])(
  "erro %i preserva formulário e referência; só conflito/incerteza exigem recarga",
  async (status) => {
    const normalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) =>
        options?.method === "POST"
          ? new Response(
              JSON.stringify({
                error: {
                  message:
                    "Não foi possível confirmar o salvamento. Atualize a lista antes de tentar novamente.",
                },
              }),
              {
                status,
                headers: { "X-Request-Id": "10000000-0000-4000-8000-000000000099" },
              },
            )
          : normalFetch(url, options),
      ),
    );
    const user = userEvent.setup();
    render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
    await screen.findByText("Nenhuma mídia aprovada. O atendimento continua em texto.");
    await user.upload(
      screen.getByLabelText("Arquivo"),
      new File(["audio"], "a.mp3", { type: "audio/mpeg" }),
    );
    await user.type(screen.getByLabelText("Título da mídia"), "Apresentação");
    await user.type(
      screen.getByLabelText("Conteúdo e finalidade da mídia"),
      "Demonstração sobre o serviço",
    );
    await user.type(
      screen.getByLabelText("Condição e exemplos de perguntas"),
      "Quando pedir uma demonstração",
    );
    await user.click(screen.getByRole("button", { name: "Aprovar mídia para o agente" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Referência: 10000000-0000-4000-8000-000000000099",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Título da mídia")).toHaveValue("Apresentação");
    expect(screen.getByLabelText("Arquivo")).not.toHaveValue("");
    if (status === 422) {
      expect(screen.getByRole("button", { name: "Aprovar mídia para o agente" })).toBeEnabled();
      return;
    }
    expect(screen.getByRole("button", { name: "Aprovar mídia para o agente" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Atualizar lista" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Aprovar mídia para o agente" })).toBeEnabled(),
    );
    expect(screen.getByLabelText("Título da mídia")).toHaveValue("Apresentação");
  },
);

it('anexa, ouve antes de aprovar, salva e permite retirar a aprovação', async () => {
  const user = userEvent.setup();
  render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
  await screen.findByText('Nenhuma mídia aprovada. O atendimento continua em texto.');
  await user.upload(screen.getByLabelText('Arquivo'), new File(['audio'], 'apresentacao.mp3', { type: 'audio/mpeg' }));
  expect(screen.getByLabelText('Conferir arquivo antes de aprovar')).toHaveAttribute('src', 'blob:test');
  await user.type(screen.getByLabelText('Título da mídia'), 'Apresentação');
  await user.type(screen.getByLabelText('Conteúdo e finalidade da mídia'), 'Quando perguntar sobre o aplicativo');
  await user.type(screen.getByLabelText('Condição e exemplos de perguntas'), 'Quando pedir como funciona o serviço');
  await user.click(screen.getByRole('button', { name: 'Aprovar mídia para o agente' }));
  await screen.findByText('Apresentação');
  const body = calls.find(c => c.method === 'POST')!.body as FormData;
  expect(body.get('title')).toBe('Apresentação'); expect(body.get('file')).toBeInstanceOf(File);
  expect(body.get('required')).toBe('true');
  expect(body.get('trigger_type')).toBe('topic');
  expect(body.get('send_when')).toBe('Quando pedir como funciona o serviço');
  expect(screen.getByLabelText('Apresentação')).toHaveAttribute('src', 'https://signed.example/a.ogg');
  await user.click(screen.getByRole('switch', { name: 'Ativar mídia: Apresentação' }));
  await screen.findByText('Desativado');
  expect(JSON.parse(calls.find(c => c.method === 'PATCH')!.body as string)).toEqual({ audio_id: 'audio-1', enabled: false });
});
it('expõe falha de leitura e não oferece escrita a quem só pode consultar', async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Sem permissão.' } }), { status: 403 }));
  render(<ApprovedAudios agentId="agent-1" readOnly />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sem permissão.');
  expect(screen.queryByLabelText('Arquivo')).toBeNull();
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

it('permite recepção no primeiro contato sem condição de assunto e conserva após editar', async () => {
  const user = userEvent.setup(); const view = render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
  await screen.findByText('Nenhuma mídia aprovada. O atendimento continua em texto.');
  await user.upload(screen.getByLabelText('Arquivo'), new File(['audio'], 'recepcao.mp3', { type: 'audio/mpeg' }));
  await user.type(screen.getByLabelText('Título da mídia'), 'Recepção');
  await user.type(screen.getByLabelText('Conteúdo e finalidade da mídia'), 'Apresentação da equipe de atendimento');
  await user.selectOptions(screen.getByLabelText('Quando enviar esta mídia'), 'first_contact');
  expect(screen.queryByLabelText('Condição e exemplos de perguntas')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Aprovar mídia para o agente' }));
  await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
  const data = calls.find(c => c.method === 'POST')!.body as FormData;
  expect(data.get('trigger_type')).toBe('first_contact');
  view.unmount(); render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
  await screen.findByRole('button', { name: 'Editar mídia' });
  await user.click(screen.getByRole('button', { name: 'Editar mídia' }));
  expect(screen.getAllByLabelText('Quando enviar esta mídia')[0]).toHaveValue('first_contact');
});
it('não aprova uma regra por assunto sem descrever quando enviar', async () => {
  const user = userEvent.setup(); render(<ApprovedAudios agentId="agent-1" readOnly={false} />);
  await screen.findByText('Nenhuma mídia aprovada. O atendimento continua em texto.');
  await user.upload(screen.getByLabelText('Arquivo'), new File(['audio'], 'a.mp3', { type: 'audio/mpeg' }));
  await user.type(screen.getByLabelText('Título da mídia'), 'Explicação');
  await user.type(screen.getByLabelText('Conteúdo e finalidade da mídia'), 'Explicação gravada sobre o serviço');
  await user.click(screen.getByRole('button', { name: 'Aprovar mídia para o agente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Descreva a condição de envio');
  expect(calls.some(c => c.method === 'POST')).toBe(false);
});
