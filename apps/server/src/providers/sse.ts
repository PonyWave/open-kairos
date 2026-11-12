export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = extractEvents(buffer);
      buffer = parsed.remainder;
      yield* parsed.events;
    }
    buffer += decoder.decode();
    const final = extractEvents(`${buffer}\n\n`);
    yield* final.events;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function extractEvents(buffer: string): { events: string[]; remainder: string } {
  const pendingCR = buffer.endsWith('\r');
  const input = pendingCR ? buffer.slice(0, -1) : buffer;
  const normalized = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const parts = normalized.split('\n\n');
  const remainder = `${parts.pop() ?? ''}${pendingCR ? '\r' : ''}`;
  const events = parts
    .map((part) =>
      part
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter((data) => data.length > 0);
  return { events, remainder };
}
