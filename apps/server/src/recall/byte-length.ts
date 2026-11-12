export function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '"' || character === '\\') bytes += 2;
    else if (codePoint < 0x20) {
      bytes += ['\b', '\t', '\n', '\f', '\r'].includes(character) ? 2 : 6;
    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) bytes += 6;
    else bytes += Buffer.byteLength(character, 'utf8');
  }
  return bytes;
}
