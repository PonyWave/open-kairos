import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationScrollController,
  conversationWheelGestureIdleMs,
} from './conversation-scroll.js';

class Viewport {
  scrollHeight = 1200;
  clientHeight = 400;
  writes: number[] = [];
  private top = 0;
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    this.writes.push(this.top);
  }
  userScroll(top: number) {
    this.top = top;
  }
}
function fixture() {
  const target = new Viewport(),
    controller = new ConversationScrollController(target);
  controller.setEnabled(true);
  controller.layout();
  target.writes = [];
  return { target, controller };
}

describe('conversation auto scroll', () => {
  it('starts at the bottom and follows text growth and composer resizing with immediate writes', () => {
    const { target, controller } = fixture();
    expect(target.scrollTop).toBe(800);
    target.scrollHeight = 1350;
    controller.layout();
    expect(target.scrollTop).toBe(950);
    target.clientHeight = 350;
    controller.layout();
    expect(target.scrollTop).toBe(1000);
  });
  it('pauses before an upward gesture, including a fraction of a pixel from the bottom', () => {
    const { target, controller } = fixture();
    controller.intent('up');
    target.userScroll(799.8);
    controller.scrolled();
    for (let n = 0; n < 20; n++) {
      target.scrollHeight += 10;
      controller.layout();
      controller.scrolled();
    }
    expect(target.scrollTop).toBe(799.8);
    expect(target.writes).toEqual([]);
  });
  it('does not let a pending resize or a late send receipt override scrolling up after sending', () => {
    const { target, controller } = fixture();
    controller.follow();
    controller.intent('up');
    target.userScroll(500);
    controller.scrolled();
    target.scrollHeight = 1600;
    controller.layout();
    controller.layout();
    expect(target.scrollTop).toBe(500);
    expect(target.writes).toEqual([]);
  });
  it('resumes only after explicit downward scrolling reaches the bottom', () => {
    const { target, controller } = fixture();
    controller.intent('up');
    target.userScroll(500);
    controller.scrolled();
    target.scrollHeight = 1400;
    controller.layout();
    controller.intent('down');
    target.userScroll(900);
    controller.scrolled();
    target.scrollHeight = 1500;
    controller.layout();
    expect(target.scrollTop).toBe(900);
    target.userScroll(1100);
    controller.scrolled();
    target.scrollHeight = 1700;
    controller.layout();
    expect(target.scrollTop).toBe(1300);
  });
  it('treats automatic clamping when Thinking collapses as a layout change', () => {
    const { target, controller } = fixture();
    target.scrollHeight = 900;
    target.userScroll(500);
    controller.scrolled();
    target.scrollHeight = 1400;
    controller.layout();
    expect(target.scrollTop).toBe(1000);
  });
  it('keeps a located source message fixed and lets an explicit new send resume following', () => {
    const { target, controller } = fixture();
    controller.pause();
    target.userScroll(200);
    controller.scrolled();
    target.scrollHeight = 1500;
    controller.layout();
    expect(target.scrollTop).toBe(200);
    controller.follow();
    expect(target.scrollTop).toBe(1100);
  });
  it('does not reposition an invisible or zero-height pane', () => {
    const { target, controller } = fixture();
    controller.setEnabled(false);
    target.scrollHeight = 1500;
    controller.layout();
    expect(target.writes).toEqual([]);
    controller.setEnabled(true);
    target.clientHeight = 0;
    controller.layout();
    expect(target.writes).toEqual([]);
  });
  it('pauses for scrollbar dragging and resumes at its bottom', () => {
    const { target, controller } = fixture();
    controller.scrollbarDragging(true);
    controller.pause();
    target.userScroll(300);
    controller.scrolled();
    target.scrollHeight = 1400;
    controller.layout();
    expect(target.scrollTop).toBe(300);
    target.userScroll(1000);
    controller.scrolled();
    controller.scrollbarDragging(false);
    target.scrollHeight = 1500;
    controller.layout();
    expect(target.scrollTop).toBe(1100);
  });
});

describe('conversation earlier history scrolling', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function topFixture(onLoadEarlier: () => boolean) {
    const target = new Viewport();
    const controller = new ConversationScrollController(target, undefined, onLoadEarlier);
    controller.setEnabled(true);
    controller.layout();
    return { target, controller };
  }

  it('loads once for a continuous upward gesture at the top and rearms after it ends', () => {
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    target.userScroll(0);

    controller.intent('up');
    controller.intent('up');
    expect(loads).toBe(1);

    controller.endGesture();
    controller.intent('up');
    expect(loads).toBe(2);
  });

  it('waits for a new gesture after reaching the top instead of loading from inertia', () => {
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });

    controller.intent('up');
    expect(loads).toBe(0);
    target.userScroll(0);
    controller.scrolled();
    for (let event = 0; event < 20; event++) controller.intent('up');
    expect(loads).toBe(0);

    controller.endGesture();
    controller.intent('up');
    expect(loads).toBe(1);
  });

  it('does not load again when direction changes within a gesture', () => {
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    target.userScroll(0);

    controller.intent('up');
    controller.intent('down');
    controller.intent('up');
    expect(loads).toBe(1);

    controller.endGesture();
    controller.intent('up');
    expect(loads).toBe(2);
  });

  it('requires a full idle interval before a new wheel event can load history', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });

    controller.wheelIntent('up');
    target.userScroll(0);
    controller.scrolled();
    for (let event = 0; event < 20; event++) {
      vi.advanceTimersByTime(40);
      controller.wheelIntent('up');
    }
    expect(loads).toBe(0);
    vi.advanceTimersByTime(conversationWheelGestureIdleMs - 1);
    controller.wheelIntent('up');
    expect(loads).toBe(0);

    vi.advanceTimersByTime(conversationWheelGestureIdleMs);
    expect(loads).toBe(0);
    controller.wheelIntent('up');
    controller.wheelIntent('up');
    expect(loads).toBe(1);
  });

  it('recognizes a new gesture even when the browser delays the idle timer', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });

    controller.wheelIntent('up');
    target.userScroll(0);
    controller.scrolled();
    vi.setSystemTime(Date.now() + conversationWheelGestureIdleMs);
    controller.wheelIntent('up');
    expect(loads).toBe(1);
  });

  it('loads when a new upward push interrupts the decaying wheel momentum', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    const wheel = (magnitude: number) => {
      vi.advanceTimersByTime(16);
      controller.wheelIntent('up', magnitude);
    };

    wheel(80);
    target.userScroll(0);
    controller.scrolled();
    for (const magnitude of [60, 42, 28, 15, 10]) wheel(magnitude);
    expect(loads).toBe(0);

    wheel(14);
    wheel(24);
    expect(loads).toBe(1);
    for (const magnitude of [18, 12, 8, 4, 2, 1]) wheel(magnitude);
    expect(loads).toBe(1);

    wheel(30);
    expect(loads).toBe(2);
  });

  it('ignores small fluctuations in the momentum tail and the initial acceleration to the top', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    controller.wheelIntent('up', 3);
    target.userScroll(0);
    controller.scrolled();
    for (const magnitude of [6, 12, 25, 50, 90, 60, 40, 20, 12, 7, 4, 2, 1, 2, 1, 3, 2, 1]) {
      vi.advanceTimersByTime(16);
      controller.wheelIntent('up', magnitude);
    }
    expect(loads).toBe(0);
  });

  it('detects a gentle renewed push across consecutive samples', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    controller.wheelIntent('up', 40);
    target.userScroll(0);
    controller.scrolled();
    for (const magnitude of [20, 10, 4, 2, 1, 4, 5]) {
      vi.advanceTimersByTime(16);
      controller.wheelIntent('up', magnitude);
    }
    expect(loads).toBe(1);
  });

  it('cancels the old wheel timer when a touch or key gesture begins', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });

    controller.wheelIntent('up');
    controller.endGesture();
    controller.intent('up');
    target.userScroll(0);
    controller.scrolled();
    vi.advanceTimersByTime(conversationWheelGestureIdleMs);
    controller.intent('up');
    expect(loads).toBe(0);

    controller.endGesture();
    controller.intent('up');
    expect(loads).toBe(1);
  });

  it('does not restart a gesture when following resumes in a short viewport', () => {
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    target.scrollHeight = target.clientHeight;
    target.userScroll(0);

    controller.intent('down');
    controller.intent('up');
    expect(loads).toBe(0);

    controller.endGesture();
    controller.intent('up');
    expect(loads).toBe(1);
  });

  it('does not load while the pane is disabled', () => {
    vi.useFakeTimers();
    let loads = 0;
    const { target, controller } = topFixture(() => {
      loads += 1;
      return true;
    });
    controller.wheelIntent('up');
    target.userScroll(0);
    controller.setEnabled(false);
    vi.advanceTimersByTime(conversationWheelGestureIdleMs);
    controller.intent('up');
    controller.wheelIntent('up');
    expect(loads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    controller.setEnabled(true);
    controller.wheelIntent('up');
    expect(loads).toBe(1);
  });
});
