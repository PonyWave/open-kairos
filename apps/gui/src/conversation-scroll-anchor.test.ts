import { describe, expect, it } from 'vitest';
import {
  captureConversationScrollAnchor,
  restoreConversationScrollAnchor,
} from './conversation-scroll-anchor.js';

describe('conversation history reading position', () => {
  it('keeps the visible message fixed when history is prepended while text also streams below', () => {
    const target = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 };
    const anchor = captureConversationScrollAnchor(target, [
      { key: 'message', top: 40, bottom: 160 },
    ]);

    target.scrollHeight += 1000;
    restoreConversationScrollAnchor(target, anchor, [
      { key: 'earlier-message', top: 0, bottom: 500 },
      { key: 'message', top: 840, bottom: 960 },
    ]);

    expect(target.scrollTop).toBe(800);
    expect(840 - target.scrollTop).toBe(40);
  });

  it('does not compensate twice when native scroll anchoring already preserves the message', () => {
    const target = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 };
    const anchor = captureConversationScrollAnchor(target, [
      { key: 'message', top: 40, bottom: 160 },
    ]);

    target.scrollHeight += 800;
    target.scrollTop = 800;
    restoreConversationScrollAnchor(target, anchor, [{ key: 'message', top: 40, bottom: 160 }]);

    expect(target.scrollTop).toBe(800);
  });

  it('preserves a partially visible message instead of scrolling to its beginning', () => {
    const target = { scrollTop: 200, scrollHeight: 1200, clientHeight: 400 };
    const anchor = captureConversationScrollAnchor(target, [
      { key: 'clipped-message', top: -100, bottom: 200 },
    ]);

    target.scrollHeight += 600;
    restoreConversationScrollAnchor(target, anchor, [
      { key: 'clipped-message', top: 500, bottom: 800 },
    ]);

    expect(target.scrollTop).toBe(800);
    expect(500 - (target.scrollTop - 200)).toBe(-100);
  });

  it('uses another visible message when the last batch removes the old date and loading row', () => {
    const target = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 };
    const anchor = captureConversationScrollAnchor(target, [
      { key: 'date', top: 20, bottom: 40 },
      { key: 'message', top: 60, bottom: 140 },
    ]);

    target.scrollHeight += 614;
    restoreConversationScrollAnchor(target, anchor, [{ key: 'message', top: 674, bottom: 754 }]);

    expect(target.scrollTop).toBe(614);
  });

  it('falls back to the height difference if the previously visible elements were replaced', () => {
    const target = { scrollTop: 100, scrollHeight: 1200, clientHeight: 400 };
    const anchor = captureConversationScrollAnchor(target, [
      { key: 'old-message', top: 0, bottom: 200 },
    ]);

    target.scrollHeight += 500;
    restoreConversationScrollAnchor(target, anchor, [
      { key: 'replacement', top: 500, bottom: 700 },
    ]);

    expect(target.scrollTop).toBe(600);
  });
});
