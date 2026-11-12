import { describe, expect, it } from 'vitest';
import { renderFeishuCards, renderFeishuTextFallback } from './render-feishu.js';
import { markdownToPlainText, renderWechatSegments, segmentPlainText } from './render-wechat.js';

describe('markdownToPlainText', () => {
  it('strips inline markdown and keeps structure', () => {
    expect(markdownToPlainText('# 标题\n\n**加粗** 和 *斜体* 以及 `代码`。')).toBe(
      '标题\n\n加粗 和 斜体 以及 代码。',
    );
    expect(markdownToPlainText('[文档](https://example.com/docs)')).toBe(
      '文档 (https://example.com/docs)',
    );
    expect(markdownToPlainText('![截图](https://example.com/a.png)')).toBe('[图片: 截图]');
  });

  it('converts tables into record-style lines', () => {
    const markdown = '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | **5** |';
    expect(markdownToPlainText(markdown)).toBe('名称：苹果，数量：3\n名称：香蕉，数量：5');
  });

  it('keeps list items as text lines', () => {
    expect(markdownToPlainText('- 第一项\n- 第二项')).toBe('- 第一项\n- 第二项');
  });
});

describe('renderWechatSegments', () => {
  it('returns no segments for empty content', () => {
    expect(renderWechatSegments('')).toEqual([]);
    expect(renderWechatSegments('  \n ')).toEqual([]);
  });

  it('splits long content on paragraph boundaries within the byte budget', () => {
    const paragraph = '汉'.repeat(400);
    const segments = renderWechatSegments([paragraph, paragraph, paragraph].join('\n\n'), 1500);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(Buffer.byteLength(segment, 'utf8')).toBeLessThanOrEqual(1500);
    }
    expect(segments.join('\n\n')).toContain(paragraph);
  });

  it('hard splits a single oversized line', () => {
    const segments = segmentPlainText('字'.repeat(2000), 1500);
    expect(segments.length).toBe(4);
    for (const segment of segments) {
      expect(Buffer.byteLength(segment, 'utf8')).toBeLessThanOrEqual(1500);
    }
    expect(segments.join('')).toBe('字'.repeat(2000));
  });
});

describe('renderFeishuCards', () => {
  it('renders markdown blocks into a card', () => {
    const cards = renderFeishuCards('第一段。\n\n第二段。');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.msgType).toBe('interactive');
    const card = JSON.parse(cards[0]?.content ?? '');
    expect(card.schema).toBe('2.0');
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: '第一段。\n\n第二段。' }]);
  });

  it('converts tables into native table components', () => {
    const cards = renderFeishuCards('前文。\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |');
    const card = JSON.parse(cards[0]?.content ?? '');
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: '前文。' });
    expect(card.body.elements[1].tag).toBe('table');
    expect(card.body.elements[1].columns).toEqual([
      { name: 'c0', display_name: '名称', data_type: 'text' },
      { name: 'c1', display_name: '数量', data_type: 'text' },
    ]);
    expect(card.body.elements[1].rows).toEqual([{ c0: '苹果', c1: '3' }]);
  });

  it('splits into multiple cards when the budget is exceeded', () => {
    const section = `段落${'长'.repeat(9_000)}`;
    const cards = renderFeishuCards([section, section, section].join('\n\n'));
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      expect(Buffer.byteLength(card.content, 'utf8')).toBeLessThanOrEqual(30_000);
    }
  });

  it('splits tables beyond the per-card table limit into a new card', () => {
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const cards = renderFeishuCards(new Array(6).fill(table).join('\n\n'));
    expect(cards).toHaveLength(2);
    const first = JSON.parse(cards[0]?.content ?? '');
    const second = JSON.parse(cards[1]?.content ?? '');
    expect(
      first.body.elements.filter((element: { tag: string }) => element.tag === 'table'),
    ).toHaveLength(5);
    expect(
      second.body.elements.filter((element: { tag: string }) => element.tag === 'table'),
    ).toHaveLength(1);
  });
});

describe('renderFeishuTextFallback', () => {
  it('renders plain text payloads', () => {
    const payloads = renderFeishuTextFallback('**结果**：完成');
    expect(payloads).toEqual([
      { msgType: 'text', content: JSON.stringify({ text: '结果：完成' }) },
    ]);
  });
});
