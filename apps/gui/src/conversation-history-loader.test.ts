import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationHistoryLoader,
  conversationHistoryLoadingMinMs,
} from './conversation-history-loader.js';
import {
  captureConversationScrollAnchor,
  restoreConversationScrollAnchor,
} from './conversation-scroll-anchor.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('conversation history loading', () => {
  it('keeps loading visible for the minimum interval and combines repeated requests', () => {
    const onLoadingChange = vi.fn();
    const load = vi.fn();
    const loader = new ConversationHistoryLoader(onLoadingChange);

    expect(loader.start(load)).toBe(true);
    expect(onLoadingChange.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(conversationHistoryLoadingMinMs - 1);
    expect(load).not.toHaveBeenCalled();
    expect(loader.start(load)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onLoadingChange.mock.calls).toEqual([[true], [false]]);
    expect(loader.start(load)).toBe(true);
  });

  it('cancels delayed history changes when leaving the conversation', () => {
    const onLoadingChange = vi.fn();
    const load = vi.fn();
    const loader = new ConversationHistoryLoader(onLoadingChange);

    loader.start(load);
    loader.cancel();
    vi.advanceTimersByTime(conversationHistoryLoadingMinMs);

    expect(load).not.toHaveBeenCalled();
    expect(onLoadingChange.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores the current reading position when the user moves during the loading interval', () => {
    const target = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 };
    const loader = new ConversationHistoryLoader(() => {});
    loader.start(() => {
      const anchor = captureConversationScrollAnchor(target, [
        { key: 'message', top: -target.scrollTop, bottom: 300 - target.scrollTop },
      ]);
      target.scrollHeight += 600;
      restoreConversationScrollAnchor(target, anchor, [
        { key: 'message', top: 600 - target.scrollTop, bottom: 900 - target.scrollTop },
      ]);
    });

    vi.advanceTimersByTime(100);
    target.scrollTop = 100;
    vi.advanceTimersByTime(conversationHistoryLoadingMinMs - 100);

    expect(target.scrollTop).toBe(700);
  });

  it('clears the loading state and preserves the cause when a delayed update fails', () => {
    const onLoadingChange = vi.fn();
    const loader = new ConversationHistoryLoader(onLoadingChange);
    const error = new Error('history update failed');
    loader.start(() => {
      throw error;
    });

    expect(() => vi.advanceTimersByTime(conversationHistoryLoadingMinMs)).toThrow(error);
    expect(onLoadingChange.mock.calls).toEqual([[true], [false]]);
    expect(loader.start(() => {})).toBe(true);
  });
});
