import { type RefObject, useLayoutEffect, useRef } from 'react';

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

/** Only reveal appended messages while following the conversation's bottom. */
export function useMessageEntrance(
  viewportRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  context: string,
) {
  const previous = useRef<{ context: string; keys: string[] } | null>(null);
  const animations = useRef(new Set<Animation>());

  useLayoutEffect(() => {
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
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) {
      previous.current = null;
      for (const animation of animations.current) animation.cancel();
      animations.current.clear();
      return;
    }
    const elements = Array.from(
      viewport.querySelectorAll<HTMLElement>('.message-list > [data-message-id]'),
    );
    const keys = elements.map(
      (element) => element.dataset.displayId ?? element.dataset.messageId ?? '',
    );
    const before = previous.current;
    previous.current = { context, keys };
    if (
      !before ||
      before.context !== context ||
      viewport.dataset.followBottom === 'false' ||
      document.visibilityState === 'hidden' ||
      window.matchMedia(reducedMotionQuery).matches
    )
      return;

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
      // Opacity preserves the geometry used by conversation scroll anchoring.
      const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        id: 'kairos-message-enter',
      });
      animations.current.add(animation);
      const release = () => animations.current.delete(animation);
      animation.onfinish = release;
      animation.oncancel = release;
    }
  });
}
