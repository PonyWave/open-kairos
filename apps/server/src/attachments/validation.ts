import { SessionError } from '../sessions/errors.js';
import type { AttachmentMediaType } from './types.js';

export const MAX_ATTACHMENTS_PER_INPUT = 4;
export const MAX_ATTACHMENT_BYTES = 700_000;
export const MAX_ATTACHMENT_TOTAL_BYTES = 2_800_000;
export const MAX_TEXT_ATTACHMENT_BYTES = 200_000;
export const MAX_TEXT_ATTACHMENT_TOTAL_BYTES = 256 * 1024;
export const MAX_DOWNLOAD_BYTES = 256 * 1024;
export const MAX_MODEL_REQUEST_BYTES = 16 * 1024 * 1024;
export const LOW_DETAIL_IMAGE_TOKENS = 1024;

export interface ValidatedAttachment {
  mediaType: AttachmentMediaType;
  width?: number;
  height?: number;
}

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = createCrcTable();

export function validateFileName(value: string): string {
  if (value.trim().length === 0 || value.length > 255) {
    throw new SessionError(
      'invalid_argument',
      'fileName must contain between 1 and 255 characters.',
    );
  }
  if (
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new SessionError('invalid_argument', 'fileName must be a plain file name.');
  }
  return value;
}

export function validateAttachmentBytes(bytes: Uint8Array): ValidatedAttachment {
  if (bytes.length === 0) {
    throw new SessionError('invalid_argument', 'Attachment content must not be empty.');
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new SessionError('input_too_large', 'Attachment exceeds the 700000-byte file limit.');
  }
  if (startsWith(bytes, pngSignature)) return validatePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return validateJpeg(bytes);
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch (error) {
    throw new SessionError(
      'invalid_argument',
      'Attachment must be strict UTF-8 text, PNG or JPEG.',
      { cause: error },
    );
  }
  if (text.includes('\0')) {
    throw new SessionError('invalid_argument', 'Text attachments must not contain NUL.');
  }
  if (bytes.length > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new SessionError(
      'input_too_large',
      'Text attachment exceeds the 200000-byte file limit.',
    );
  }
  return { mediaType: 'text/plain' };
}

export function decodeTextAttachment(bytes: Uint8Array): string {
  const validated = validateAttachmentBytes(bytes);
  if (validated.mediaType !== 'text/plain') {
    throw new SessionError('internal', 'Stored attachment media type does not match its content.');
  }
  return textDecoder.decode(bytes);
}

export function maximumUploadBytes(maxRpcBytes: number): number {
  return Math.min(MAX_ATTACHMENT_BYTES, Math.max(0, Math.floor(((maxRpcBytes - 2048) * 3) / 4)));
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function validatePng(bytes: Uint8Array): ValidatedAttachment {
  let offset = pngSignature.length;
  let width: number | undefined;
  let height: number | undefined;
  let sawImageData = false;
  let chunkIndex = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return invalidPng();
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const end = dataOffset + length;
    if (!Number.isSafeInteger(end) || end + 4 > bytes.length) return invalidPng();
    const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
    const expectedCrc = readUint32(bytes, end);
    if (crc32(bytes.subarray(typeOffset, end)) !== expectedCrc) return invalidPng();
    if (chunkIndex === 0 && type !== 'IHDR') return invalidPng();
    if (type === 'IHDR') {
      if (chunkIndex !== 0 || length !== 13) return invalidPng();
      width = readUint32(bytes, dataOffset);
      height = readUint32(bytes, dataOffset + 4);
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        return invalidPng();
      }
      const depth = bytes[dataOffset + 8];
      const color = bytes[dataOffset + 9];
      if (
        depth === undefined ||
        color === undefined ||
        ![1, 2, 4, 8, 16].includes(depth) ||
        ![0, 2, 3, 4, 6].includes(color) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        ![0, 1].includes(bytes[dataOffset + 12] ?? -1)
      ) {
        return invalidPng();
      }
    } else if (type === 'IDAT') {
      sawImageData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || end + 4 !== bytes.length || width === undefined || !sawImageData) {
        return invalidPng();
      }
      return { mediaType: 'image/png', width, height: height ?? 0 };
    }
    offset = end + 4;
    chunkIndex += 1;
  }
  return invalidPng();
}

function invalidPng(): never {
  throw new SessionError('invalid_argument', 'PNG attachment has an invalid structure.');
}

function validateJpeg(bytes: Uint8Array): ValidatedAttachment {
  let offset = 2;
  let width: number | undefined;
  let height: number | undefined;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return invalidJpeg();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xff) {
      return invalidJpeg();
    }
    if (marker === 0xd9) {
      if (offset !== bytes.length || width === undefined || height === undefined || !sawScan) {
        return invalidJpeg();
      }
      return { mediaType: 'image/jpeg', width, height };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return invalidJpeg();
    const length = readUint16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return invalidJpeg();
    const dataOffset = offset + 2;
    const end = offset + length;
    if (isStartOfFrame(marker)) {
      if (width !== undefined || length < 8) return invalidJpeg();
      const components = bytes[dataOffset + 5];
      if (
        components === undefined ||
        components === 0 ||
        length !== 8 + components * 3 ||
        ![8, 12].includes(bytes[dataOffset] ?? -1)
      ) {
        return invalidJpeg();
      }
      height = readUint16(bytes, dataOffset + 1);
      width = readUint16(bytes, dataOffset + 3);
      if (width === 0 || height === 0) return invalidJpeg();
    }
    offset = end;
    if (marker === 0xda) {
      sawScan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === undefined) return invalidJpeg();
        if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
          offset += next === 0xff ? 1 : 2;
          continue;
        }
        break;
      }
    }
  }
  return invalidJpeg();
}

function invalidJpeg(): never {
  throw new SessionError('invalid_argument', 'JPEG attachment has an invalid structure.');
}

function isStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
    marker,
  );
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
