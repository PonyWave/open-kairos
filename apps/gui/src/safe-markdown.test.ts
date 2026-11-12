import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown, safeMarkdownUrl } from './safe-markdown.js';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(SafeMarkdown, null, markdown));
}

describe('SafeMarkdown', () => {
  it('renders formatting without raw HTML, scripts, or event handlers', () => {
    const html = render(
      '**保留格式** <img src="x" onerror="window.compromised=true"><script>window.compromised=true</script>',
    );
    expect(html).toContain('<strong>保留格式</strong>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('removes dangerous links and does not load external images', () => {
    const html = render(
      '[危险](javascript:alert(1)) [安全](https://example.com) ![追踪](https://example.com/pixel)',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.com/pixel');
    expect(html).toContain('[图片：追踪]');
    expect(html).not.toContain('node=');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  it('renders command output as text rather than executable markup', () => {
    const html = render('```sh\nprintf "<script>alert(1)</script>"\n```');
    expect(html).toContain('<code');
    expect(html).not.toContain('<script>');
  });
});

describe('safeMarkdownUrl', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/test',
    'mailto:a@b.c',
    '//evil.test',
  ])('rejects %s', (url) => {
    expect(safeMarkdownUrl(url)).toBe('');
  });

  it('allows local paths and HTTP(S)', () => {
    expect(safeMarkdownUrl('/context/1')).toBe('/context/1');
    expect(safeMarkdownUrl('http://localhost:4317')).toBe('http://localhost:4317');
    expect(safeMarkdownUrl('https://example.com')).toBe('https://example.com');
  });
});
