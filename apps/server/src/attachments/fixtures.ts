export const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const jpegBytes = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
  'base64',
);

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function sizedJpegBytes(size: number): Uint8Array {
  if (size < jpegBytes.length) throw new RangeError('Requested JPEG size is too small.');
  const padding = size - jpegBytes.length;
  if (padding === 0) return jpegBytes;
  const count = Math.ceil(padding / 65537);
  if (count * 4 > padding) throw new RangeError('Requested JPEG size is invalid.');
  const segments: Uint8Array[] = [];
  let remaining = padding;
  for (let index = 0; index < count; index += 1) {
    const segmentSize = index === count - 1 ? remaining : Math.floor(padding / count);
    remaining -= segmentSize;
    const segment = new Uint8Array(segmentSize);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    const length = segmentSize - 2;
    segment[2] = length >>> 8;
    segment[3] = length & 0xff;
    segments.push(segment);
  }
  return Buffer.concat([jpegBytes.subarray(0, 2), ...segments, jpegBytes.subarray(2)]);
}
