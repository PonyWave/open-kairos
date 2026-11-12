import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function styles(): Promise<string> {
  return (await readFile(new URL('./styles.css', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
}

describe('workbench visual stability', () => {
  it('keeps avatar geometry fixed and reveals plain text time without moving content', async () => {
    const css = await styles();
    expect(css).toContain('.message-avatar-container { position: relative;');
    expect(css).toContain('flex: 0 0 24px');
    expect(css).toContain('.message-avatar-container:hover .message-time');
    expect(css).toContain('.message-avatar-container:focus .message-time');
    expect(css).toContain('top: var(--message-time-top, 0);');
    expect(css).toContain('left: var(--message-time-left, 0);');
    expect(css).not.toContain('.message-avatar-container:hover .message-avatar');
  });

  it('makes the right topic full-width on narrow screens without removing the main layout', async () => {
    const css = await styles();
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('.session-layout.with-topic .conversation-main { display: none; }');
    expect(css).toContain('.session-layout.with-topic .conversation-topic');
    expect(css).toContain('max-width: none');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps nested code transparent with equal-specificity selectors in cascade order', async () => {
    const css = await styles();
    const inlineCodeRule = '.markdown code {';
    const nestedCodeRule = '.markdown :where(pre) code {';
    expect(css).toContain(
      `${inlineCodeRule} font-size: 0.92em; padding: 1px 4px; border-radius: 4px; background: var(--wash); }`,
    );
    expect(css).toContain(`${nestedCodeRule} padding: 0; background: transparent; }`);
    expect(css.indexOf(nestedCodeRule)).toBeGreaterThan(css.indexOf(inlineCodeRule));
  });
});
