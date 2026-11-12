import { describe, expect, it } from 'vitest';
import { type MessageTimeSide, observeMessageTimePosition } from './message-time-layout.js';

function fixture(side: MessageTimeSide) {
  const paneRect = { left: 224, right: 1000, top: 0, bottom: 900 };
  const scrollRect = { left: 224, right: 1000, top: 80, bottom: 800 };
  const avatarRect = { left: 600, right: 624, top: 200, bottom: 224 };
  const properties = new Map<string, string>();
  const timeGeometry = { width: 60, height: 20 };
  let scrollListener: (() => void) | undefined;
  let scrollListenerRemoved = false;
  const pane = {
    getBoundingClientRect: () => paneRect,
  } as unknown as Element;
  const scroll = {
    getBoundingClientRect: () => scrollRect,
    offsetWidth: 776,
    clientWidth: 776,
    addEventListener(_type: 'scroll', listener: () => void) {
      scrollListener = listener;
    },
    removeEventListener(_type: 'scroll', listener: () => void) {
      scrollListenerRemoved = scrollListener === listener;
    },
  } as unknown as HTMLElement;
  const avatar = {
    dataset: {} as DOMStringMap,
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    getBoundingClientRect: () => avatarRect,
    closest: (selector: string) => (selector === '.session-scroll' ? scroll : pane),
  } as unknown as HTMLButtonElement;
  const timeElement = {
    get offsetWidth() {
      return timeGeometry.width;
    },
    get offsetHeight() {
      return timeGeometry.height;
    },
    style: { visibility: '' },
  } as unknown as HTMLTimeElement;
  const resizeCallbacks: (() => void)[] = [];
  const mutationCallbacks: (() => void)[] = [];
  const resizeTargets: Element[] = [];
  const mutationTargets: Element[] = [];
  let resizeDisconnected = false;
  let mutationDisconnected = false;
  let mutationOptions: MutationObserverInit | undefined;
  let windowListener: (() => void) | undefined;
  let listenerRemoved = false;
  const windowObject = {
    innerWidth: 1200,
    innerHeight: 1000,
    addEventListener(_type: 'resize', listener: () => void) {
      windowListener = listener;
    },
    removeEventListener(_type: 'resize', listener: () => void) {
      listenerRemoved = windowListener === listener;
    },
  };
  const cleanup = observeMessageTimePosition({
    avatar,
    timeElement,
    side,
    windowObject,
    resizeObserverFactory(callback) {
      resizeCallbacks.push(callback);
      return {
        observe(target) {
          resizeTargets.push(target);
        },
        disconnect() {
          resizeDisconnected = true;
        },
      };
    },
    mutationObserverFactory(callback) {
      mutationCallbacks.push(callback);
      return {
        observe(target, options) {
          mutationTargets.push(target);
          mutationOptions = options;
        },
        disconnect() {
          mutationDisconnected = true;
        },
      };
    },
  });
  return {
    avatar,
    pane,
    paneRect,
    scroll,
    scrollRect,
    avatarRect,
    timeGeometry,
    timeElement,
    windowObject,
    properties,
    resizeCallbacks,
    mutationCallbacks,
    resizeTargets,
    mutationTargets,
    cleanup,
    windowListener: () => windowListener,
    scrollListener: () => scrollListener,
    disconnected: () => ({
      resizeDisconnected,
      mutationDisconnected,
      listenerRemoved,
      scrollListenerRemoved,
    }),
    mutationOptions: () => mutationOptions,
  };
}

describe('message time pane observation', () => {
  it.each(['left', 'right'] as const)(
    'keeps the %s timestamp beside a centered conversation when the full scroll area has room',
    (side) => {
      const layout = fixture(side);
      layout.windowObject.innerWidth = 1440;
      layout.paneRect.right = 1440;
      layout.scrollRect.right = 1440;
      layout.avatarRect.left = side === 'left' ? 446 : 1194;
      layout.avatarRect.right = layout.avatarRect.left + 24;
      for (const callback of layout.resizeCallbacks) callback();

      expect(layout.avatar.dataset.timePosition).toBe(side);
      expect(layout.properties.get('--message-time-top')).toBe('2px');
      expect(layout.properties.get('--message-time-left')).toBe(side === 'left' ? '-66px' : '30px');
      layout.cleanup();
    },
  );

  it('remeasures when the main pane narrows and restores the side after the right pane closes', () => {
    const layout = fixture('right');

    expect(layout.avatar.dataset.timePosition).toBe('right');
    expect(layout.resizeTargets).toContain(layout.pane);
    expect(layout.mutationTargets).toContain(layout.pane);

    layout.paneRect.right = 650;
    for (const callback of layout.resizeCallbacks) callback();
    expect(layout.avatar.dataset.timePosition).toBe('above');

    layout.paneRect.right = 1000;
    for (const callback of layout.mutationCallbacks) callback();
    expect(layout.avatar.dataset.timePosition).toBe('right');
    expect(layout.mutationOptions()).toEqual({
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style'],
    });

    layout.cleanup();
    expect(layout.disconnected()).toEqual({
      resizeDisconnected: true,
      mutationDisconnected: true,
      listenerRemoved: true,
      scrollListenerRemoved: true,
    });
  });

  it('uses the current pane boundary after a narrow-screen or visibility change', () => {
    const layout = fixture('left');
    layout.avatarRect.left = 420;
    layout.avatarRect.right = 444;
    layout.paneRect.left = 400;
    layout.paneRect.right = 800;

    for (const callback of layout.resizeCallbacks) callback();
    expect(layout.avatar.dataset.timePosition).toBe('above');

    layout.paneRect.left = 100;
    layout.windowListener()?.();
    expect(layout.avatar.dataset.timePosition).toBe('left');

    layout.paneRect.left = 400;
    for (const callback of layout.mutationCallbacks) callback();
    expect(layout.avatar.dataset.timePosition).toBe('above');
    layout.cleanup();
  });

  it('keeps long timestamps above the left edge inside the topic scroll area', () => {
    const layout = fixture('left');
    layout.paneRect.left = 600;
    layout.scrollRect.left = 600;
    layout.avatarRect.left = 624;
    layout.avatarRect.right = 648;
    layout.timeGeometry.width = 160;

    for (const callback of layout.resizeCallbacks) callback();
    expect(layout.avatar.dataset.timePosition).toBe('above');
    const left =
      layout.avatarRect.left +
      Number.parseFloat(layout.properties.get('--message-time-left') ?? 'NaN');
    expect(left).toBe(604);
    expect(left + layout.timeGeometry.width).toBeLessThanOrEqual(layout.scrollRect.right - 4);
    expect(layout.properties.get('--message-time-top')).toBe('-24px');
    expect(layout.resizeTargets).toContain(layout.scroll);
    layout.cleanup();
  });

  it('keeps long timestamps above the right edge inside the scroll area', () => {
    const layout = fixture('right');
    layout.avatarRect.left = 952;
    layout.avatarRect.right = 976;
    layout.timeGeometry.width = 160;

    layout.windowListener()?.();
    expect(layout.avatar.dataset.timePosition).toBe('above');
    const left =
      layout.avatarRect.left +
      Number.parseFloat(layout.properties.get('--message-time-left') ?? 'NaN');
    expect(left + layout.timeGeometry.width).toBe(996);
    layout.cleanup();
  });

  it('uses the space below near the scroll top and updates while scrolling', () => {
    const layout = fixture('left');
    layout.avatarRect.left = 240;
    layout.avatarRect.right = 264;
    layout.avatarRect.top = 90;
    layout.avatarRect.bottom = 114;
    layout.scrollListener()?.();
    expect(layout.avatar.dataset.timePosition).toBe('below');
    expect(layout.properties.get('--message-time-top')).toBe('28px');

    layout.avatarRect.top = 150;
    layout.avatarRect.bottom = 174;
    layout.scrollListener()?.();
    expect(layout.avatar.dataset.timePosition).toBe('above');
    expect(layout.properties.get('--message-time-top')).toBe('-24px');

    layout.avatarRect.top = 40;
    layout.avatarRect.bottom = 64;
    layout.scrollListener()?.();
    expect(layout.timeElement.style.visibility).toBe('hidden');
    layout.avatarRect.top = 150;
    layout.avatarRect.bottom = 174;
    layout.scrollListener()?.();
    expect(layout.timeElement.style.visibility).toBe('');
    layout.cleanup();
  });
});
