import { markdownToPlainText, parseMarkdownBlocks, segmentPlainText } from './render-wechat.js';

const cardContentBudgetBytes = 24_000;
const maxTablesPerCard = 5;
const defaultTextSegmentBytes = 150_000;

export interface FeishuMessagePayload {
  msgType: 'interactive' | 'text';
  content: string;
}

interface CardElement {
  tag: 'markdown' | 'table';
  content?: string;
  columns?: { name: string; display_name: string; data_type: 'text' }[];
  rows?: Record<string, string>[];
}

function tableElement(header: string[], rows: string[][]): CardElement {
  const columns = header.map((display, index) => ({
    name: `c${index}`,
    display_name: display.length > 0 ? display : `列${index + 1}`,
    data_type: 'text' as const,
  }));
  return {
    tag: 'table',
    columns,
    rows: rows.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? ''])),
    ),
  };
}

function buildCard(elements: CardElement[]): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { elements },
  });
}

export function renderFeishuCards(markdown: string): FeishuMessagePayload[] {
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) return [];
  const cards: FeishuMessagePayload[] = [];
  let elements: CardElement[] = [];
  let tables = 0;
  let size = 0;
  const flush = () => {
    if (elements.length === 0) return;
    cards.push({ msgType: 'interactive', content: buildCard(elements) });
    elements = [];
    tables = 0;
    size = 0;
  };
  const pushElement = (element: CardElement, elementSize: number) => {
    if (
      size + elementSize > cardContentBudgetBytes ||
      (element.tag === 'table' && tables >= maxTablesPerCard)
    ) {
      flush();
    }
    elements.push(element);
    size += elementSize;
    if (element.tag === 'table') tables += 1;
  };
  const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
  for (const block of blocks) {
    if (block.kind === 'table') {
      pushElement(tableElement(block.header, block.rows), byteLength(JSON.stringify(block)));
      continue;
    }
    for (const segment of segmentPlainText(block.text, cardContentBudgetBytes)) {
      pushElement({ tag: 'markdown', content: segment }, byteLength(segment));
    }
  }
  flush();
  return cards;
}

export function renderFeishuTextFallback(markdown: string): FeishuMessagePayload[] {
  const plain = markdownToPlainText(markdown);
  if (plain.length === 0) return [];
  return segmentPlainText(plain, defaultTextSegmentBytes).map((segment) => ({
    msgType: 'text' as const,
    content: JSON.stringify({ text: segment }),
  }));
}
