import type { Input } from '@kairos/contracts';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { projectQueuedInputs } from './conversation.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { reorderQueuedIds } from './queue-draft.js';
import { QueueDragGhost, type QueueDragGhostState } from './queue-drag-ghost.js';
import { queueDragTargetIndex } from './queue-drag-position.js';

export function reconcileQueueOrder(
  order: readonly string[],
  current: readonly string[],
): string[] {
  const active = new Set(current),
    existing = new Set(order);
  return [...order.filter((id) => active.has(id)), ...current.filter((id) => !existing.has(id))];
}

export function QueueStack({
  inputs,
  busy,
  onEdit,
  onRemove,
  onReorder,
}: {
  inputs: readonly Input[];
  busy: boolean;
  onEdit: (input: Input) => Promise<void>;
  onRemove: (input: Input) => Promise<void>;
  onReorder: (ids: string[]) => Promise<boolean>;
}) {
  const queued = projectQueuedInputs(inputs);
  const [dragging, setDragging] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [ghost, setGhost] = useState<QueueDragGhostState | null>(null);
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const listRef = useRef<HTMLOListElement>(null);
  const beforeRects = useRef(new Map<string, number>());
  const animations = useRef(new Map<string, Animation>());
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const currentIds = queued.map((input) => input.inputId);
  const liveKey = JSON.stringify(currentIds);
  const draggingPresent = dragging === null || currentIds.includes(dragging);
  const currentIdsRef = useRef(currentIds);
  currentIdsRef.current = currentIds;
  const orderRef = useRef(currentIds);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const helpId = useId();
  const displayIds = reconcileQueueOrder(preview ?? currentIds, currentIds);
  orderRef.current = displayIds;
  const byId = new Map(queued.map((input) => [input.inputId, input]));
  async function persist(ids: string[]) {
    if (busyRef.current || savingRef.current) {
      setPreview(null);
      return;
    }
    if (JSON.stringify(ids) === JSON.stringify(currentIdsRef.current)) {
      setPreview(null);
      return;
    }
    setError(null);
    savingRef.current = true;
    setSaving(true);
    setPreview(ids);
    try {
      if (!(await onReorderRef.current(ids))) setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPreview(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (dragging || saving || !preview) return;
    if (JSON.stringify(reconcileQueueOrder(preview, currentIdsRef.current)) === liveKey)
      setPreview(null);
  }, [dragging, liveKey, preview, saving]);
  useEffect(() => {
    if (!dragging || draggingPresent) return;
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    ghostRef.current = null;
    setGhost(null);
    setDragging(null);
    setPreview(null);
  }, [dragging, draggingPresent]);
  useLayoutEffect(() => {
    if (!preview || !listRef.current || !beforeRects.current.size) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const row of listRef.current.querySelectorAll<HTMLElement>('[data-queued-id]')) {
      const id = row.dataset.queuedId;
      if (!id) continue;
      animations.current.get(id)?.cancel();
      const before = beforeRects.current.get(id),
        after = row.getBoundingClientRect().top;
      if (
        !reduced &&
        id !== dragging &&
        before !== undefined &&
        Math.abs(before - after) > 0.5 &&
        typeof row.animate === 'function'
      )
        animations.current.set(
          id,
          row.animate(
            [{ transform: `translateY(${before - after}px)` }, { transform: 'translateY(0)' }],
            { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' },
          ),
        );
    }
    beforeRects.current.clear();
  }, [preview, dragging]);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      for (const animation of animations.current.values()) animation.cancel();
    },
    [],
  );
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const current = ghostRef.current;
      if (!current || current.settling || event.pointerId !== current.pointerId) return;
      const nextGhost = {
        ...current,
        left: event.clientX - current.offsetX,
        top: event.clientY - current.offsetY,
      };
      ghostRef.current = nextGhost;
      setGhost(nextGhost);
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-queued-id]'));
      const top = list.getBoundingClientRect().top;
      const centers = rows.map((row) => top + row.offsetTop + row.offsetHeight / 2);
      const order = reconcileQueueOrder(orderRef.current, currentIdsRef.current);
      const from = order.indexOf(dragging);
      if (from < 0) return;
      const index = queueDragTargetIndex(centers, nextGhost.top + nextGhost.height / 2, from);
      const target = order[index];
      if (!target || index === from) return;
      const next = reorderQueuedIds(order, dragging, target);
      beforeRects.current = new Map(
        Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-queued-id]') ?? []).map(
          (row) => [row.dataset.queuedId ?? '', row.getBoundingClientRect().top],
        ),
      );
      orderRef.current = next;
      setPreview(next);
    };
    const finish = (event: PointerEvent) => {
      const current = ghostRef.current;
      if (!current || current.settling || event.pointerId !== current.pointerId) return;
      const finalOrder = reconcileQueueOrder(orderRef.current, currentIdsRef.current);
      const row = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-queued-id]') ?? [],
      ).find((element) => element.dataset.queuedId === dragging);
      const target = row?.getBoundingClientRect();
      const settling = {
        ...current,
        settling: true,
        ...(target
          ? { left: target.left, top: target.top, width: target.width, height: target.height }
          : {}),
      };
      ghostRef.current = settling;
      setGhost(settling);
      void persistRef.current(finalOrder);
      const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        ghostRef.current = null;
        setGhost(null);
        setDragging(null);
      }, duration);
    };
    const cancel = (event: Event) => {
      if ('pointerId' in event && event.pointerId !== ghostRef.current?.pointerId) return;
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      ghostRef.current = null;
      setGhost(null);
      setDragging(null);
      setPreview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging]);
  if (queued.length === 0) return null;
  return (
    <fieldset className="queue-stack" aria-label="排队消息">
      <p className="sr-only" id={helpId}>
        拖动左侧把手即时调整顺序，松开后保存，也可使用上下方向键。
      </p>
      <ol ref={listRef}>
        {displayIds.map((id, index) => {
          const input = byId.get(id);
          if (!input) return null;
          return (
            <li key={id} data-queued-id={id} className={dragging === id ? 'dragging' : ''}>
              <button
                type="button"
                className="icon-button queue-grip"
                disabled={busy || saving || ghost?.settling}
                aria-label={`调整第 ${index + 1} 条排队消息顺序`}
                aria-describedby={helpId}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  const target = displayIds[index + (event.key === 'ArrowUp' ? -1 : 1)];
                  if (target) void persist(reorderQueuedIds(displayIds, id, target));
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || busy || saving || dragging) return;
                  event.preventDefault();
                  const bounds = event.currentTarget.closest('li')?.getBoundingClientRect();
                  if (!bounds) return;
                  const nextGhost: QueueDragGhostState = {
                    pointerId: event.pointerId,
                    input,
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.width,
                    height: bounds.height,
                    offsetX: event.clientX - bounds.left,
                    offsetY: event.clientY - bounds.top,
                    settling: false,
                  };
                  ghostRef.current = nextGhost;
                  setGhost(nextGhost);
                  orderRef.current = displayIds;
                  setPreview(displayIds);
                  setDragging(id);
                }}
              >
                <Icon name="grip" className="i-sm" />
              </button>
              <span
                className="queue-text"
                title={input.text || input.attachments.map((file) => file.fileName).join('、')}
              >
                {input.text || input.attachments.map((file) => file.fileName).join('、')}
              </span>
              {input.attachments.length > 0 && (
                <span
                  className="queue-attachment-count"
                  title={`${input.attachments.length} 个附件`}
                >
                  <Icon name="clip" className="i-sm" />
                  {input.attachments.length}
                </span>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="编辑排队消息"
                title="移到输入框编辑"
                disabled={busy || saving || input.delegation !== undefined}
                onClick={() => void onEdit(input)}
              >
                <Icon name="edit" className="i-sm" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="删除排队消息"
                title="删除排队消息"
                disabled={busy || saving || input.delegation !== undefined}
                onClick={() => void onRemove(input)}
              >
                <Icon name="trash" className="i-sm" />
              </button>
            </li>
          );
        })}
      </ol>
      {ghost && <QueueDragGhost ghost={ghost} />}
      {error && <FailureNotice label="队列排序失败" message={error} />}
    </fieldset>
  );
}
