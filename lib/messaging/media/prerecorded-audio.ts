import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIO_MAX_BYTES } from '@/lib/ai/agents/approved-audios';

// Demuxer explícito: não interpretar arquivo enviado como playlist ou URL.
const FORMATS: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'mov',
  'audio/x-m4a': 'mov', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/opus': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/webm': 'matroska',
};

export function prerecordedAudioFormat(mime: string): string | null {
  return FORMATS[mime.split(';')[0]!.trim().toLowerCase()] ?? null;
}

async function convert(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { cwd, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('audio_conversion_failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('audio_conversion_failed'));
    });
  });
}

/** Falha fechada: só aprovar gravação efetivamente decodificada e normalizada. */
export async function normalizePrerecordedAudio(
  bytes: Buffer, mime: string,
  run: typeof convert = convert,
): Promise<Buffer> {
  const format = prerecordedAudioFormat(mime);
  if (!format || !bytes.length || bytes.length > AUDIO_MAX_BYTES) throw new Error('invalid_audio');
  const dir = await mkdtemp(join(tmpdir(), 'approved-audio-'));
  try {
    const source = join(dir, 'source');
    const output = join(dir, 'voice.ogg');
    await writeFile(source, bytes);
    await run(['-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-f', format,
      '-i', source, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'libopus',
      '-ac', '1', '-ar', '48000', '-b:a', '32k',
      '-f', 'ogg', output], dir);
    const info = await stat(output);
    if (info.size <= 0 || info.size > AUDIO_MAX_BYTES) throw new Error('invalid_audio');
    const normalized = await readFile(output);
    if (normalized.subarray(0, 4).toString() !== 'OggS' || !normalized.subarray(0, 256).includes(Buffer.from('OpusHead'))) {
      throw new Error('invalid_audio');
    }
    return normalized;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
