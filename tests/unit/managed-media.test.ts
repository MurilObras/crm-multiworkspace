// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readApprovedMedia, mediaKind, mediaPathOwnedBy, legacyAudioProjection } from '@/lib/ai/agents/approved-media';
import { approvedAudioSchema } from '@/lib/ai/agents/approved-audios';
import { explicitMediaPreference, refersToPreviousMedia } from '@/lib/agent-engine/agent/media-preference';
import { validateApprovedVisual, approvedVisualFormat } from '@/lib/messaging/media/approved-visual';

const org = '10000000-0000-4000-8000-000000000001';
const agent = '10000000-0000-4000-8000-000000000002';
const id = '10000000-0000-4000-8000-000000000003';
const common = { id, title: 'Apresentação', use_when: 'Explica como funciona o serviço', enabled: true, size_bytes: 100 };

it('preserva catálogo de áudio antigo sem ativar reenvio ou obrigatoriedade', () => {
  const [audio] = readApprovedMedia({ approved_audios: [{ ...common, mime: 'audio/ogg', storage_path: `${org}/agent-audios/${agent}/${id}.ogg` }] });
  expect(audio).toBeDefined(); expect(mediaKind(audio!)).toBe('audio');
  expect(audio!.required).toBe(false); expect(audio!.allow_requested_repeat).toBeUndefined();
});
it('catálogo novo prevalece sobre projeção antiga e não aceita tipo/MIME incompatíveis', () => {
  const photo = { ...common, type: 'image', mime: 'image/png', storage_path: `${org}/agent-media/${agent}/${id}.png` };
  const [media] = readApprovedMedia({ approved_media: [photo], approved_audios: [] });
  expect(mediaKind(media!)).toBe('image'); expect(mediaPathOwnedBy(media!,org,agent)).toBe(true);
  expect(mediaPathOwnedBy(media!,agent,org)).toBe(false);
  expect(readApprovedMedia({ approved_media: [{ ...photo, type: 'video' }] })).toEqual([]);
});
it('projeção de áudio continua válida para o schema strict anterior à ampliação', () => {
  const catalog = readApprovedMedia({ approved_media: [{ ...common, mime:'audio/ogg', storage_path:`${org}/agent-audios/${agent}/${id}.ogg`,
    allow_requested_repeat:true,content_sha256:'a'.repeat(64),storage_sha256:'b'.repeat(64) }] });
  const legacy = legacyAudioProjection(catalog);
  const oldSchema = approvedAudioSchema.omit({allow_requested_repeat:true,content_sha256:true,storage_sha256:true});
  expect(oldSchema.safeParse(legacy[0]).success).toBe(true);
  expect(catalog[0]?.allow_requested_repeat).toBe(true);
  expect(legacy[0]).not.toHaveProperty('allow_requested_repeat');
});
it.each([
  ['Manda aquele áudio novamente','audio','audio'],
  ['Me explica por áudio como funciona','audio','audio'],
  ['Não explique por áudio','audio','text'],
  ['Manda de novo o vídeo','video','audio'],
  ['Repete a foto','image','audio'],
  ['Pode me reenviar o vídeo?','video','audio'],
  ['Me envie a imagem de novo','image','audio'],
  ['Não mande foto','image','text'],
  ['Só texto agora','video','text'],
  ['Como funciona?','audio',null],
  ['Você envia vídeo?','video',null],
] as const)('pedido %s para %s não confunde pergunta com preferência', (text,kind,result) => {
  expect(explicitMediaPreference(text,kind)).toBe(result);
});
it('referência genérica usa o último arquivo, mas assunto nomeado preserva seleção semântica', () => {
  expect(refersToPreviousMedia('Paulo, manda aquele áudio de novo, por favor')).toBe(true);
  expect(refersToPreviousMedia('Mande o vídeo de preços novamente')).toBe(false);
});
it('não aprova HTML renomeado e exige decodificação além da assinatura', async () => {
  expect(approvedVisualFormat(Buffer.from('<script>1</script>'),'image/jpeg')).toBeNull();
  const bytes = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const decode = vi.fn(async (_args: string[], _cwd: string) => { throw new Error('truncated'); });
  await expect(validateApprovedVisual(bytes,'image/png',decode)).rejects.toThrow('truncated');
  expect(decode).toHaveBeenCalledOnce();
  expect(decode.mock.calls[0]![0]).toContain('-protocol_whitelist');
});
