import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntityMark, mainAgentColor, threadColor } from './entity-mark.js';
import { messageTimePosition } from './message-avatar.js';

describe('EntityMark', () => {
  it('uses the new path and a stable thread-specific color', () => {
    const first = renderToStaticMarkup(createElement(EntityMark, { threadId: 'task-a' }));
    const repeated = renderToStaticMarkup(createElement(EntityMark, { threadId: 'task-a' }));
    const other = renderToStaticMarkup(createElement(EntityMark, { threadId: 'task-b' }));

    expect(first).toBe(repeated);
    expect(first).toContain('M97 45C110 39');
    expect(first).toContain(`data-thread-color="${threadColor('task-a')}"`);
    expect(first).not.toContain(mainAgentColor);
    expect(other).not.toContain(threadColor('task-a'));
  });

  it('keeps the main Agent mark monochrome', () => {
    const html = renderToStaticMarkup(createElement(EntityMark, { mainAgent: true }));
    expect(html).toContain(`data-thread-color="${mainAgentColor}"`);
    expect(html).toContain('entity-main');
  });
});

describe('message time layout', () => {
  it('uses the assigned side while space is sufficient', () => {
    expect(
      messageTimePosition({
        avatarLeft: 200,
        avatarRight: 224,
        viewportWidth: 800,
        timeWidth: 90,
        side: 'left',
      }),
    ).toBe('left');
    expect(
      messageTimePosition({
        avatarLeft: 700,
        avatarRight: 724,
        viewportWidth: 800,
        timeWidth: 60,
        side: 'right',
      }),
    ).toBe('right');
  });

  it('moves only the time above when horizontal space is insufficient', () => {
    expect(
      messageTimePosition({
        avatarLeft: 24,
        avatarRight: 48,
        viewportWidth: 800,
        timeWidth: 90,
        side: 'left',
      }),
    ).toBe('above');
    expect(
      messageTimePosition({
        avatarLeft: 760,
        avatarRight: 784,
        viewportWidth: 800,
        timeWidth: 60,
        side: 'right',
      }),
    ).toBe('above');
    expect(
      messageTimePosition({
        avatarLeft: 430,
        avatarRight: 454,
        viewportLeft: 410,
        viewportWidth: 800,
        timeWidth: 40,
        side: 'left',
      }),
    ).toBe('above');
  });
});
