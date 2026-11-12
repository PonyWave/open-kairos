const defaultSegmentBytes = 1500;

interface TableBlock {
  kind: 'table';
  header: string[];
  rows: string[][];
}

interface TextBlock {
  kind: 'text';
  text: string;
}

export type MarkdownBlock = TextBlock | TableBlock;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split('\n');
  const blocks: MarkdownBlock[] = [];
  let textBuffer: string[] = [];
  const flushText = () => {
    const text = textBuffer.join('\n').trim();
    if (text.length > 0) blocks.push({ kind: 'text', text });
    textBuffer = [];
  };
  let index = 0;
  let inFence = false;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      textBuffer.push(line);
      index += 1;
      continue;
    }
    if (
      !inFence &&
      line.trim().startsWith('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? '')
    ) {
      flushText();
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    textBuffer.push(line);
    index += 1;
  }
  flushText();
  return blocks;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_match, alt: string) => `[图片${alt ? `: ${alt}` : ''}]`,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

export function markdownToPlainText(markdown: string): string {
  const blocks = parseMarkdownBlocks(markdown);
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'table') {
      const lines: string[] = [];
      for (const row of block.rows) {
        const cells = block.header.map((header, cellIndex) => {
          const value = stripInlineMarkdown(row[cellIndex] ?? '');
          return header.length > 0 ? `${stripInlineMarkdown(header)}：${value}` : value;
        });
        lines.push(cells.join('，'));
      }
      parts.push(lines.join('\n'));
      continue;
    }
    const lines = block.text.split('\n').map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading) return stripInlineMarkdown(heading[1] ?? '');
      const fence = line.match(/^\s*```/);
      if (fence) return '';
      return stripInlineMarkdown(line);
    });
    parts.push(
      lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    );
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hardSplit(text: string, maxBytes: number): string[] {
  const segments: string[] = [];
  let current = '';
  for (const character of text) {
    if (byteLength(current + character) > maxBytes && current.length > 0) {
      segments.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function segmentPlainText(text: string, maxBytes: number = defaultSegmentBytes): string[] {
  const segments: string[] = [];
  let current = '';
  const push = (piece: string) => {
    const candidate = current.length === 0 ? piece : `${current}\n\n${piece}`;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      return;
    }
    if (current.length > 0) {
      segments.push(current);
      current = '';
    }
    if (byteLength(piece) <= maxBytes) {
      current = piece;
      return;
    }
    const lines = piece.split('\n');
    let lineBuffer = '';
    for (const line of lines) {
      const candidateLine = lineBuffer.length === 0 ? line : `${lineBuffer}\n${line}`;
      if (byteLength(candidateLine) <= maxBytes) {
        lineBuffer = candidateLine;
        continue;
      }
      if (lineBuffer.length > 0) {
        segments.push(lineBuffer);
        lineBuffer = '';
      }
      if (byteLength(line) > maxBytes) {
        segments.push(...hardSplit(line, maxBytes));
      } else {
        lineBuffer = line;
      }
    }
    if (lineBuffer.length > 0) current = lineBuffer;
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.trim().length === 0) continue;
    push(paragraph);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function renderWechatSegments(
  markdown: string,
  maxBytes: number = defaultSegmentBytes,
): string[] {
  const plain = markdownToPlainText(markdown);
  if (plain.length === 0) return [];
  return segmentPlainText(plain, maxBytes);
}
