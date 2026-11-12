import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ConversationHistoryLoader } from './conversation-history-loader.js';
import { ConversationScrollController } from './conversation-scroll.js';
import {
  type ConversationScrollAnchor,
  captureConversationScrollAnchor,
  restoreConversationScrollAnchor,
} from './conversation-scroll-anchor.js';

function anchorPositions(viewport: HTMLElement, stableKeys = false) {
  const viewportTop = viewport.getBoundingClientRect().top;
  return Array.from(
    viewport.querySelectorAll('.message-list > :not(.earlier-discussions)'),
    (element) => {
      const rect = element.getBoundingClientRect();
      return {
        key: stableKeys
          ? (element.getAttribute?.('data-display-id') ??
            element.getAttribute?.('data-message-id') ??
            element)
          : element,
        top: rect.top - viewportTop,
        bottom: rect.bottom - viewportTop,
      };
    },
  );
}

function nestedScrollConsumes(
  viewport: HTMLElement,
  target: EventTarget | null,
  direction: number,
): boolean {
  if (!(target instanceof Element)) return false;
  for (
    let element: Element | null = target;
    element && element !== viewport;
    element = element.parentElement
  ) {
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element);
    if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none')
      return true;
    if (
      !['auto', 'scroll'].includes(style.overflowY) ||
      element.scrollHeight <= element.clientHeight
    )
      continue;
    if (
      direction < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight
    )
      return true;
  }
  return false;
}

export function useConversationScroll(
  enabled: boolean,
  onLoadEarlier: () => boolean,
  history: { key: string; startIndex: number; displayMode?: string },
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useRef<ConversationScrollController | null>(null);
  const historyLoader = useRef<ConversationHistoryLoader | null>(null);
  const loadingHistoryKey = useRef<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const enabledRef = useRef(enabled);
  const loadEarlierRef = useRef(onLoadEarlier);
  const historyRef = useRef(history);
  const pendingAnchor = useRef<{
    key: string;
    startIndex: number;
    anchor: ConversationScrollAnchor<Element | string>;
  } | null>(null);
  const displayAnchor = useRef<{
    key: string;
    mode: string | undefined;
    following: boolean;
    anchor: ConversationScrollAnchor<Element | string>;
  } | null>(null);
  const rememberDisplayPosition = useCallback(() => {
    const viewport = viewportRef.current;
    if (!enabledRef.current || !viewport || viewport.clientHeight <= 0) return;
    displayAnchor.current = {
      key: historyRef.current.key,
      mode: historyRef.current.displayMode,
      following: viewport.dataset.followBottom !== 'false',
      anchor: captureConversationScrollAnchor(viewport, anchorPositions(viewport, true)),
    };
  }, []);
  enabledRef.current = enabled;
  loadEarlierRef.current = onLoadEarlier;
  historyRef.current = history;
  const loadEarlier = useCallback((): boolean => {
    if (
      !enabledRef.current ||
      !viewportRef.current ||
      historyRef.current.startIndex <= 0 ||
      pendingAnchor.current
    )
      return false;
    const historyKey = historyRef.current.key;
    const accepted =
      historyLoader.current?.start(() => {
        const viewport = viewportRef.current;
        if (!enabledRef.current || !viewport || historyRef.current.key !== historyKey) return;
        const position = {
          ...historyRef.current,
          anchor: captureConversationScrollAnchor(viewport, anchorPositions(viewport)),
        };
        if (loadEarlierRef.current()) pendingAnchor.current = position;
      }) ?? false;
    if (accepted) {
      loadingHistoryKey.current = historyKey;
      controller.current?.pause();
    }
    return accepted;
  }, []);
  useLayoutEffect(() => {
    const viewport = viewportRef.current,
      content = contentRef.current;
    if (!viewport || !content) return;
    const loader = new ConversationHistoryLoader(setLoadingEarlier);
    historyLoader.current = loader;
    const instance = new ConversationScrollController(
      viewport,
      (following) => {
        viewport.dataset.followBottom = String(following);
      },
      loadEarlier,
    );
    controller.current = instance;
    viewport.dataset.followBottom = 'true';
    instance.setEnabled(enabledRef.current);
    let frame: number | null = null;
    function resize() {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        instance.layout();
      });
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(viewport);
    observer?.observe(content);
    const scroll = () => {
      instance.scrolled();
      rememberDisplayPosition();
    };
    const wheel = (event: WheelEvent) => {
      const deltaMode = event.deltaMode;
      if (
        event.ctrlKey ||
        event.shiftKey ||
        event.deltaY === 0 ||
        nestedScrollConsumes(viewport, event.target, event.deltaY)
      )
        return;
      const unit =
        deltaMode === 1
          ? Number.parseFloat(getComputedStyle(viewport).lineHeight) || 16
          : deltaMode === 2
            ? viewport.clientHeight
            : 1;
      instance.wheelIntent(event.deltaY < 0 ? 'up' : 'down', Math.abs(event.deltaY) * unit);
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => {
      instance.endGesture();
      touchY = event.touches[0]?.clientY ?? null;
    };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next === undefined || touchY === null) return;
      const direction = touchY - next;
      touchY = next;
      if (direction !== 0 && !nestedScrollConsumes(viewport, event.target, direction))
        instance.intent(direction < 0 ? 'up' : 'down');
    };
    const touchEnd = () => {
      touchY = null;
      instance.endGesture();
    };
    let scrollKey: string | null = null;
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      let direction: 'up' | 'down';
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home')
        direction = 'up';
      else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End')
        direction = 'down';
      else if (
        event.key === ' ' &&
        !(event.target instanceof Element && event.target.closest('button,a'))
      )
        direction = event.shiftKey ? 'up' : 'down';
      else return;
      if (!event.repeat) instance.endGesture();
      scrollKey = event.key;
      instance.intent(direction);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key !== scrollKey) return;
      scrollKey = null;
      instance.endGesture();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target === viewport) {
        instance.scrollbarDragging(true);
        instance.pause();
      }
    };
    const pointerUp = () => instance.scrollbarDragging(false);
    viewport.addEventListener('scroll', scroll, { passive: true });
    viewport.addEventListener('wheel', wheel, { passive: true, capture: true });
    viewport.addEventListener('touchstart', touchStart, { passive: true, capture: true });
    viewport.addEventListener('touchmove', touchMove, { passive: true, capture: true });
    viewport.addEventListener('touchend', touchEnd, { passive: true, capture: true });
    viewport.addEventListener('touchcancel', touchEnd, { passive: true, capture: true });
    viewport.addEventListener('keydown', key, { capture: true });
    window.addEventListener('keyup', keyUp);
    viewport.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    window.addEventListener('resize', resize);
    return () => {
      instance.setEnabled(false);
      loader.cancel();
      historyLoader.current = null;
      loadingHistoryKey.current = null;
      pendingAnchor.current = null;
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', scroll);
      viewport.removeEventListener('wheel', wheel, { capture: true });
      viewport.removeEventListener('touchstart', touchStart, { capture: true });
      viewport.removeEventListener('touchmove', touchMove, { capture: true });
      viewport.removeEventListener('touchend', touchEnd, { capture: true });
      viewport.removeEventListener('touchcancel', touchEnd, { capture: true });
      viewport.removeEventListener('keydown', key, { capture: true });
      window.removeEventListener('keyup', keyUp);
      viewport.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
      window.removeEventListener('resize', resize);
      controller.current = null;
    };
  }, [loadEarlier, rememberDisplayPosition]);
  useLayoutEffect(() => {
    controller.current?.setEnabled(enabled);
    if (!enabled || loadingHistoryKey.current !== history.key) {
      historyLoader.current?.cancel();
      loadingHistoryKey.current = null;
    }
    const viewport = viewportRef.current;
    const previousDisplay = displayAnchor.current;
    if (
      enabled &&
      viewport &&
      previousDisplay?.key === history.key &&
      previousDisplay.mode !== history.displayMode
    ) {
      if (!previousDisplay.following) {
        controller.current?.pause();
        restoreConversationScrollAnchor(
          viewport,
          previousDisplay.anchor,
          anchorPositions(viewport, true),
        );
      }
    }
    const pending = pendingAnchor.current;
    if (pending) {
      if (!enabled || pending.key !== history.key || history.startIndex > pending.startIndex) {
        pendingAnchor.current = null;
      } else if (viewport && history.startIndex < pending.startIndex) {
        pendingAnchor.current = null;
        restoreConversationScrollAnchor(viewport, pending.anchor, anchorPositions(viewport));
      }
    }
    controller.current?.layout();
    rememberDisplayPosition();
  });
  const followAfterSend = useCallback(() => {
    historyLoader.current?.cancel();
    loadingHistoryKey.current = null;
    pendingAnchor.current = null;
    controller.current?.follow();
  }, []);
  const pauseFollowing = useCallback(() => controller.current?.pause(), []);
  return { viewportRef, contentRef, followAfterSend, pauseFollowing, loadEarlier, loadingEarlier };
}
