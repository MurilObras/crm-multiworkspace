// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { writeFile, access } from 'node:fs/promises';
import { normalizePrerecordedAudio } from '@/lib/messaging/media/prerecorded-audio';
import { AUDIO_MAX_BYTES, renderApprovedAudios, readApprovedAudios } from '@/lib/ai/agents/approved-audios';

it.each(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm;codecs=opus'])(
  'normaliza %s com demuxer explícito, sem rede, e limpa os temporários', async mime => {
    let directory = '';
    const run = vi.fn(async (args: string[], cwd: string) => {
      directory = cwd;
      expect(args).toContain('libopus');
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
      expect(args[args.indexOf('-f') + 1]).not.toBe('concat');
      await writeFile(args.at(-1)!, 'OggSOpusHead-test');
    });
    expect((await normalizePrerecordedAudio(Buffer.from('input'), mime, run)).toString()).toBe('OggSOpusHead-test');
    await expect(access(directory)).rejects.toThrow();
  },
);
it('falha fechada para erro, vazio, saída inválida e excesso de tamanho', async () => {
  const run = vi.fn(async () => { throw new Error('ffmpeg failed'); });
  await expect(normalizePrerecordedAudio(Buffer.from('x'), 'audio/mpeg', run)).rejects.toThrow();
  await expect(normalizePrerecordedAudio(Buffer.alloc(0), 'audio/mpeg', run)).rejects.toThrow('invalid_audio');
  await expect(normalizePrerecordedAudio(Buffer.alloc(AUDIO_MAX_BYTES + 1), 'audio/mpeg', run)).rejects.toThrow('invalid_audio');
  await expect(normalizePrerecordedAudio(Buffer.from('x'), 'text/html', run)).rejects.toThrow('invalid_audio');
  await expect(normalizePrerecordedAudio(Buffer.from('x'), 'audio/mpeg', async args => { await writeFile(args.at(-1)!, 'bad'); })).rejects.toThrow('invalid_audio');
});
it('catálogo inválido falha fechado e prompt vazio não oferece áudio', () => {
  expect(readApprovedAudios({ approved_audios: [{ storage_path: 'other-org' }] })).toEqual([]);
  expect(renderApprovedAudios([])).toBe('');
});
