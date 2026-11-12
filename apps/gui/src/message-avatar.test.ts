import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageAvatar } from './message-avatar.js';

describe('MessageAvatar', () => {
  it('uses a keyboard and touch accessible toggle without changing geometry attributes', () => {
    const html = renderToStaticMarkup(
      createElement(MessageAvatar, {
        label: 'Kairos',
        timestamp: { seconds: 0n, nanos: 0, $typeName: 'google.protobuf.Timestamp' },
        threadId: 'task-1',
        side: 'left',
      }),
    );

    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('切换时间显示');
    expect(html).toContain('data-time-position="left"');
    expect(html).toContain('class="message-avatar-container time-left"');
    expect(html).not.toContain('tabindex');
  });
});
