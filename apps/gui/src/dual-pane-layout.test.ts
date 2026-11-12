import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DualPaneLayout } from './dual-pane-layout.js';

describe('DualPaneLayout', () => {
  it('keeps the main conversation mounted while a full-screen page hides it', () => {
    const html = renderToStaticMarkup(
      createElement(
        DualPaneLayout,
        { mainVisible: false, hasTopic: false },
        createElement('section', { 'data-pane': 'main' }, '主对话状态'),
      ),
    );
    expect(html).toContain('data-main-mounted="true"');
    expect(html).toContain('hidden=""');
    expect(html).toContain('主对话状态');
    expect(html).toContain('data-topic-open="false"');
  });

  it('shows main and right topic together and retains main after the topic closes', () => {
    const render = (hasTopic: boolean) =>
      renderToStaticMarkup(
        createElement(
          DualPaneLayout,
          { mainVisible: true, hasTopic },
          createElement('section', { 'data-pane': 'main' }, '主 Run 与草稿'),
          hasTopic ? createElement('aside', { 'data-pane': 'topic' }, '独立话题') : null,
        ),
      );

    const open = render(true);
    const closed = render(false);
    expect(open).toContain('with-topic');
    expect(open).toContain('主 Run 与草稿');
    expect(open).toContain('独立话题');
    expect(closed).not.toContain('with-topic');
    expect(closed).toContain('主 Run 与草稿');
    expect(closed).not.toContain('独立话题');
  });

  it('hides only the main pane on narrow screens and restores it across topic transitions', () => {
    const render = (hasTopic: boolean, narrowViewport: boolean) =>
      renderToStaticMarkup(
        createElement(
          DualPaneLayout,
          { mainVisible: true, hasTopic, narrowViewport },
          createElement('section', { className: 'conversation-main' }, '保留的主 Run 与草稿'),
          hasTopic ? createElement('aside', { className: 'conversation-topic' }, '右侧话题') : null,
        ),
      );

    const narrowOpen = render(true, true);
    expect(narrowOpen).toContain('conversation-main" hidden=""');
    expect(narrowOpen).toContain('保留的主 Run 与草稿');
    expect(narrowOpen).toContain('conversation-topic');
    expect(narrowOpen).toContain('右侧话题');

    const desktopOpen = render(true, false);
    expect(desktopOpen).toContain('conversation-main">保留的主 Run 与草稿</section>');
    expect(desktopOpen).toContain('右侧话题');

    const narrowClosed = render(false, true);
    expect(narrowClosed).toContain('conversation-main">保留的主 Run 与草稿</section>');
    expect(narrowClosed).toContain('保留的主 Run 与草稿');
    expect(narrowClosed).not.toContain('右侧话题');

    const narrowReopened = render(true, true);
    expect(narrowReopened).toContain('conversation-main" hidden=""');
    expect(narrowReopened).toContain('保留的主 Run 与草稿');
  });
});
