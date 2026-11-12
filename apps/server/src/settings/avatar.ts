import { inflateSync } from 'node:zlib';
import { validateAttachmentBytes } from '../attachments/validation.js';
import { SessionError } from '../sessions/errors.js';

export const MAX_AVATAR_BYTES = 256 * 1024;

export function normalizeAvatar(content: Uint8Array): Buffer {
  if (content.length > MAX_AVATAR_BYTES)
    throw new SessionError('input_too_large', '头像不能超过 256 KiB。');
  const image = validateAttachmentBytes(content);
  if (
    image.mediaType !== 'image/png' ||
    !image.width ||
    !image.height ||
    image.width > 512 ||
    image.height > 512
  )
    throw new SessionError('invalid_argument', '头像须为不超过 512 × 512 像素的 PNG 图片。');
  const source = Buffer.from(content);
  if (source[24] !== 8 || ![2, 6].includes(source[25] ?? 0) || source[28] !== 0)
    throw new SessionError('invalid_argument', '头像须为 8 位、非交错的 RGB 或 RGBA PNG 图片。');
  const chunks: Buffer[] = [source.subarray(0, 8)];
  const pixels: Buffer[] = [];
  for (let offset = 8; offset < source.length; ) {
    const length = source.readUInt32BE(offset);
    const type = source.toString('ascii', offset + 4, offset + 8);
    const chunk = source.subarray(offset, offset + length + 12);
    if (['IHDR', 'IDAT', 'IEND'].includes(type)) chunks.push(chunk);
    if (type === 'IDAT') pixels.push(source.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const stride = image.width * (source[25] === 6 ? 4 : 3) + 1;
  try {
    const inflated = inflateSync(Buffer.concat(pixels), { maxOutputLength: stride * image.height });
    if (inflated.length !== stride * image.height) throw new Error('Invalid pixels');
    for (let row = 0; row < image.height; row++)
      if ((inflated[row * stride] ?? 255) > 4) throw new Error('Invalid filter');
  } catch {
    throw new SessionError('invalid_argument', '头像图片内容损坏。');
  }
  return Buffer.concat(chunks);
}
