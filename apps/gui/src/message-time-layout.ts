export type MessageTimeSide = 'left' | 'right';
export type MessageTimePosition = MessageTimeSide | 'above' | 'below';

export function messageTimePosition({
  avatarLeft,
  avatarRight,
  viewportLeft = 0,
  viewportWidth,
  timeWidth,
  side,
  avatarTop = Number.POSITIVE_INFINITY,
  viewportTop = 0,
  timeHeight = 20,
}: {
  avatarLeft: number;
  avatarRight: number;
  viewportLeft?: number;
  viewportWidth: number;
  timeWidth: number;
  side: MessageTimeSide;
  avatarTop?: number;
  viewportTop?: number;
  timeHeight?: number;
}): MessageTimePosition {
  const available = side === 'right' ? viewportWidth - avatarRight : avatarLeft - viewportLeft;
  if (available >= timeWidth + 8) return side;
  return avatarTop - viewportTop >= timeHeight + 4 ? 'above' : 'below';
}

interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

interface MutationObserverLike {
  observe(target: Element, options: MutationObserverInit): void;
  disconnect(): void;
}

interface MessageTimeWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

export function observeMessageTimePosition({
  avatar,
  timeElement,
  side,
  windowObject,
  resizeObserverFactory,
  mutationObserverFactory,
}: {
  avatar: HTMLButtonElement;
  timeElement: HTMLElement;
  side: MessageTimeSide;
  windowObject: MessageTimeWindow;
  resizeObserverFactory?: ((callback: () => void) => ResizeObserverLike) | null;
  mutationObserverFactory?: ((callback: () => void) => MutationObserverLike) | null;
}): () => void {
  const pane = avatar.closest('.conversation-pane');
  const scroll = avatar.closest<HTMLElement>('.session-scroll');
  const position = () => {
    const rect = avatar.getBoundingClientRect();
    const paneRect = pane?.getBoundingClientRect();
    const scrollRect = scroll?.getBoundingClientRect();
    const scrollbar = scroll ? Math.max(0, scroll.offsetWidth - scroll.clientWidth) : 0;
    const left = Math.max(0, paneRect?.left ?? 0, scrollRect?.left ?? 0) + 4;
    const right =
      Math.min(
        windowObject.innerWidth,
        paneRect?.right ?? windowObject.innerWidth,
        scrollRect ? scrollRect.right - scrollbar : windowObject.innerWidth,
      ) - 4;
    const top = Math.max(0, paneRect?.top ?? 0, scrollRect?.top ?? 0) + 4;
    const bottom =
      Math.min(
        windowObject.innerHeight,
        paneRect?.bottom ?? windowObject.innerHeight,
        scrollRect?.bottom ?? windowObject.innerHeight,
      ) - 4;
    const width = timeElement.offsetWidth;
    const height = timeElement.offsetHeight;
    const placement = messageTimePosition({
      avatarLeft: rect.left,
      avatarRight: rect.right,
      avatarTop: rect.top,
      viewportLeft: left,
      viewportWidth: right,
      viewportTop: top,
      timeWidth: width,
      timeHeight: height,
      side,
    });
    const x =
      placement === 'left'
        ? rect.left - width - 6
        : placement === 'right'
          ? rect.right + 6
          : (rect.left + rect.right - width) / 2;
    const y =
      placement === 'above'
        ? rect.top - height - 4
        : placement === 'below'
          ? rect.bottom + 4
          : (rect.top + rect.bottom - height) / 2;
    avatar.dataset.timePosition = placement;
    avatar.style.setProperty(
      '--message-time-left',
      `${Math.max(left, Math.min(x, right - width)) - rect.left}px`,
    );
    avatar.style.setProperty(
      '--message-time-top',
      `${Math.max(top, Math.min(y, bottom - height)) - rect.top}px`,
    );
    timeElement.style.visibility = rect.bottom <= top || rect.top >= bottom ? 'hidden' : '';
  };
  position();

  const createResizeObserver =
    resizeObserverFactory === undefined ? defaultResizeObserverFactory : resizeObserverFactory;
  const createMutationObserver =
    mutationObserverFactory === undefined
      ? defaultMutationObserverFactory
      : mutationObserverFactory;
  const resizeObserver = createResizeObserver?.(position) ?? null;
  const mutationObserver = createMutationObserver?.(position) ?? null;
  resizeObserver?.observe(avatar);
  resizeObserver?.observe(timeElement);
  if (pane) {
    resizeObserver?.observe(pane);
    mutationObserver?.observe(pane, {
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style'],
    });
  }
  if (scroll) resizeObserver?.observe(scroll);
  scroll?.addEventListener('scroll', position, { passive: true });
  windowObject.addEventListener('resize', position);

  return () => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    scroll?.removeEventListener('scroll', position);
    windowObject.removeEventListener('resize', position);
  };
}

function defaultResizeObserverFactory(callback: () => void): ResizeObserverLike | null {
  return typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(callback);
}

function defaultMutationObserverFactory(callback: () => void): MutationObserverLike | null {
  return typeof MutationObserver === 'undefined' ? null : new MutationObserver(callback);
}
