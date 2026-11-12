import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNarrowViewportServerSnapshot,
  getNarrowViewportSnapshot,
  narrowViewportQuery,
  subscribeNarrowViewport,
} from './narrow-viewport.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('narrow viewport state', () => {
  it('reads the current query and notifies changes until cleanup', () => {
    let matches = false;
    let listener: (() => void) | undefined;
    const addEventListener = vi.fn((_type: string, callback: () => void) => {
      listener = callback;
    });
    const removeEventListener = vi.fn((_type: string, callback: () => void) => {
      expect(callback).toBe(listener);
    });
    const matchMedia = vi.fn((query: string) => {
      expect(query).toBe(narrowViewportQuery);
      return {
        get matches() {
          return matches;
        },
        addEventListener,
        removeEventListener,
      };
    });
    vi.stubGlobal('window', { matchMedia });

    const onChange = vi.fn();
    const cleanup = subscribeNarrowViewport(onChange);
    expect(getNarrowViewportSnapshot()).toBe(false);
    expect(addEventListener).toHaveBeenCalledWith('change', onChange);

    matches = true;
    listener?.();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getNarrowViewportSnapshot()).toBe(true);

    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith('change', onChange);
    expect(getNarrowViewportServerSnapshot()).toBe(false);
  });
});
