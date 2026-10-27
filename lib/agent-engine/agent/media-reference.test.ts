import { describe, expect, it } from 'vitest';
import { readApprovedMedia } from '@/lib/ai/agents/approved-media';
import { resolveExplicitMediaReference } from './media-reference';
import { coherentMediaContext } from './media-response-context';
import { authorizeMediaIntent } from './media-intent';

const ID = '10000000-0000-4000-8000-000000000061';
const OTHER = '10000000-0000-4000-8000-000000000062';
function catalog() { return readApprovedMedia({ approved_media: [{ id: ID, title: 'Como funciona o Obra no Bolso',
  use_when: 'Apresentação geral sobre funcionamento do aplicativo.', send_when: 'Quando perguntar como funciona.',
  storage_path: 'sintetico.ogg', mime: 'audio/ogg', size_bytes: 10, enabled: true, required: true,
  allow_requested_repeat: true }] }); }

describe('referência explícita, sem autorização implícita', () => {
  it.each([
    ['F01', 'Agora quero ouvir a apresentação de como funciona o Obra no Bolso. Reenvia aquele áudio Como funciona, sem vídeo nem foto.'],
    ['F02', 'Agora prefiro ouvir: reenvia o áudio Como funciona o Obra no Bolso, por favor.'],
  ])('%s: reconhece as frases reais sem depender do modelo', (_id, text) => {
    expect(resolveExplicitMediaReference(text, catalog())).toMatchObject({ source: 'explicit_reference',
      intent: { audio_id: ID, format: 'audio', intent: 'repeat', text_only: false } });
  });
  it.each(['Como registrar gastos por áudio?', 'Não precisa reenviar.', 'Quero áudio', 'Como funciona?'])
    ('F03/F05/F13: não transforma menção ou pedido sem título em seleção determinística: %s', text => {
      expect(resolveExplicitMediaReference(text, catalog())).toBeNull();
    });
  it('F06: somente texto atual não seleciona arquivo mesmo quando o título aparece', () => {
    expect(resolveExplicitMediaReference('Nesta resposta só texto: explique Como funciona o aplicativo.', catalog()))
      .toMatchObject({ source: 'text_preference', intent: { audio_id: null, text_only: true } });
  });
  it('F14: dois títulos igualmente compatíveis exigem confirmação', () => {
    const media = catalog();
    expect(resolveExplicitMediaReference('Reenvia o áudio Como funciona.', [...media,
      { ...media[0]!, id: OTHER, title: 'Como funciona a cobrança' }]))
      .toMatchObject({ reason: 'ambiguous_media_reference', intent: { audio_id: null } });
  });
  it('não resolve IDs de mensagem nem escolhe formato que foi negado', () => {
    expect(resolveExplicitMediaReference(`Reenvia o áudio ${ID}.`, catalog())).toBeNull();
    expect(resolveExplicitMediaReference('Não envie áudio Como funciona o aplicativo.', catalog())?.intent.audio_id ?? null).toBeNull();
  });
  it('não confunde prefixo comum com outro assunto nomeado', () => {
    expect(resolveExplicitMediaReference('Reenvia o áudio Como funciona o pagamento.', catalog())).toBeNull();
    expect(resolveExplicitMediaReference('Reenvia o áudio funciona o Obra.', catalog())).toBeNull();
  });
  it('dois arquivos nomeados não viram escolha arbitrária pelo título mais longo', () => {
    const items = catalog();
    expect(resolveExplicitMediaReference('Reenvia o áudio Como funciona o Obra no Bolso e Preço especial.',
      [...items, { ...items[0]!, id: OTHER, title: 'Preço especial' }]))
      .toMatchObject({ reason: 'ambiguous_media_reference', intent: { audio_id: null } });
  });
  it('S01/S07/S08: identificar um título não libera repetição desligada, pendência ou mesma entrada', () => {
    const item = catalog()[0]!;
    const intent = resolveExplicitMediaReference('Reenvia o áudio Como funciona.', [item])!.intent;
    const args = { item, intent, policy: 'explicit_repeat' as const, inbound: 'new', legacyRequest: true,
      allowsFormat: true, used: [{ id: ID, confirmed: true, request: 'old' }] };
    expect(authorizeMediaIntent(args).allowed).toBe(true);
    expect(authorizeMediaIntent({ ...args, item: { ...item, allow_requested_repeat: false } }).allowed).toBe(false);
    expect(authorizeMediaIntent({ ...args, used: [{ id: ID, confirmed: false }] }).allowed).toBe(false);
    expect(authorizeMediaIntent({ ...args, inbound: 'old' }).allowed).toBe(false);
    expect(authorizeMediaIntent({ ...args, item: { ...item, enabled: false } }).allowed).toBe(false);
  });
});

describe('F02: modelo deliberadamente contraditório', () => {
  it.each([
    'Murilo, esse áudio já foi enviado nesta conversa. Posso continuar explicando o funcionamento por texto, sem repetir a apresentação.',
    'Murilo, o áudio já foi enviado nesta conversa. Nesta resposta, consigo seguir apenas por texto.',
    'Não vou reenviar esse arquivo.',
    'Não consigo enviar a imagem.',
    'Já te enviei o vídeo.',
    'Estou gravando agora esse áudio para você.',
  ])('impede contradição ou afirmação antecipada: %s', body => {
    expect(coherentMediaContext(body)).toEqual({ body: 'Sobre esse assunto:', amended: true });
  });
  it('preserva informação comercial válida em outro parágrafo', () => {
    expect(coherentMediaContext('O plano inclui as três pessoas.\n\nNão vou repetir o áudio.'))
      .toEqual({ body: 'O plano inclui as três pessoas.', amended: true });
  });
  it.each(['Você registra o gasto por áudio, informando a obra.', 'Vale comparar o gasto por obra.', 'Para rever com seu sócio:'])
    ('mantém contexto factual sem alegação de entrega: %s', body => {
      expect(coherentMediaContext(body)).toEqual({ body, amended: false });
    });
  it('não confunde vídeo recusado com áudio autorizado nem apaga origem factual da gravação', () => {
    const body = 'Não vou enviar vídeo. Essa gravação é do responsável.';
    expect(coherentMediaContext(body, 'audio')).toEqual({ body, amended: false });
  });
  it('preserva a informação comercial na mesma linha e contém negativa do formato correto', () => {
    expect(coherentMediaContext('O plano inclui três pessoas. Não consigo enviar agora.', 'audio'))
      .toEqual({ body: 'O plano inclui três pessoas.', amended: true });
    expect(coherentMediaContext('Podemos continuar sem áudio.', 'audio'))
      .toEqual({ body: 'Sobre esse assunto:', amended: true });
  });
});
