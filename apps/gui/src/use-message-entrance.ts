import { type RefObject, useLayoutEffect, useRef } from 'react';

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
const enterEasing = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Only reveal appended messages while following the conversation's bottom. */
export function useMessageEntrance(
  viewportRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  context: string,
) {
  const previous = useRef<{ context: string; keys: string[] } | null>(null);
  const seenBubbles = useRef(new WeakSet<Element>());
  const animations = useRef(new Set<Animation>());

  useLayoutEffect(() => {
    if (!viewportRef.current) return;
    const active = animations.current;
    const media = window.matchMedia(reducedMotionQuery);
    const cancel = () => {
      for (const animation of active) animation.cancel();
      active.clear();
    };
    const onChange = () => {
      if (media.matches) cancel();
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
      cancel();
    };
  }, [viewportRef]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) {
      previous.current = null;
      seenBubbles.current = new WeakSet();
      for (const animation of animations.current) animation.cancel();
      animations.current.clear();
      return;
    }
    const active = animations.current;
    const play = (node: Element, frames: Keyframe[], id: string) => {
      if (!node.animate) return;
      const animation = node.animate(frames, { duration: 260, easing: enterEasing, id });
      active.add(animation);
      const release = () => active.delete(animation);
      animation.onfinish = release;
      animation.oncancel = release;
    };
    const elements = Array.from(
      viewport.querySelectorAll<HTMLElement>('.message-list > [data-message-id]'),
    );
    const keys = elements.map(
      (element) => element.dataset.displayId ?? element.dataset.messageId ?? '',
    );
    const before = previous.current;
    previous.current = { context, keys };
    const gatesPass =
      before !== null &&
      before.context === context &&
      viewport.dataset.followBottom !== 'false' &&
      document.visibilityState !== 'hidden' &&
      !window.matchMedia(reducedMotionQuery).matches;

    // 气泡入场：新出现的气泡轻微弹出；首次渲染与历史回放只登记、不播放。
    for (const bubble of viewport.querySelectorAll('.sent-message-bubble, .pending-agent-bubble')) {
      if (seenBubbles.current.has(bubble)) continue;
      seenBubbles.current.add(bubble);
      if (!gatesPass) continue;
      if (bubble instanceof HTMLElement) bubble.style.transformOrigin = 'left bottom';
      play(
        bubble,
        [
          { opacity: 0, transform: 'translateY(4px) scale(0.92)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        'kairos-bubble-enter',
      );
    }
    if (!gatesPass || before === null) return;

    const tail = before.keys.at(-1);
    const anchor = tail === undefined ? -1 : keys.lastIndexOf(tail);
    // A replaced stream or a changed history window has no stable append boundary.
    if (tail !== undefined && anchor === -1) return;
    const known = new Set(before.keys);
    const bounds = viewport.getBoundingClientRect();
    for (const [index, element] of elements.entries()) {
      if (index <= anchor || known.has(keys[index] ?? '') || !element.animate) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      // Transform does not change layout, so scroll anchoring keeps its geometry.
      play(
        element,
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        'kairos-message-enter',
      );
    }
  });
}
