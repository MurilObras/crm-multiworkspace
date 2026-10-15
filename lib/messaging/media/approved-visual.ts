import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from './prerecorded-audio';

/** Allowlist estreita: SVG/HTML, playlists e URLs não são arquivos de apresentação. */
export function approvedVisualFormat(bytes: Buffer, mime: string): { type: 'image' | 'video'; mime: 'image/jpeg' | 'image/png' | 'video/mp4'; ext: string } | null {
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { type: 'image', mime, ext: 'jpg' };
  if (mime === 'image/png' && bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    return { type: 'image', mime, ext: 'png' };
  if (mime === 'video/mp4' && bytes.length >= 20 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size >= 16 && size <= bytes.length && size <= 4096 && size % 4 === 0) {
      const brands = [bytes.toString('ascii', 8, 12)];
      for (let i = 16; i + 4 <= size; i += 4) brands.push(bytes.toString('ascii', i, i + 4));
      if (brands.some(b => ['isom','iso2','mp41','mp42','avc1'].includes(b))) return { type: 'video', mime, ext: 'mp4' };
    }
  }
  return null;
}

/** A assinatura não basta: rejeita mídia truncada/indecodificável antes da aprovação. */
export async function validateApprovedVisual(bytes: Buffer, mime: string, run: typeof convert = convert) {
  const format = approvedVisualFormat(bytes,mime);
  if (!format) throw new Error('invalid_visual_media');
  const dir = await mkdtemp(join(tmpdir(),'approved-visual-'));
  try {
    const source = join(dir,'source');
    await writeFile(source,bytes);
    await run(['-nostdin','-v','error','-xerror','-max_alloc','67108864',
      '-protocol_whitelist','file,pipe','-codec_whitelist','h264,aac,png,mjpeg',
      '-f', format.type === 'video' ? 'mov' : format.mime === 'image/png' ? 'png_pipe' : 'mjpeg',
      ...(format.type === 'video' ? ['-enable_drefs','0'] : []),
      '-i',source,'-map','0:v:0',...(format.type === 'video' ? ['-map','0:a?'] : ['-frames:v','1']),
      '-f','null','-'],dir);
    return format;
  } finally { await rm(dir,{recursive:true,force:true}); }
}
