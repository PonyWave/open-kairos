import { describe, expect, it } from 'vitest';
import { queueDragTargetIndex } from './queue-drag-position.js';
import { reconcileQueueOrder } from './queue-stack.js';

describe('stable queue drag insertion positions', () => {
  const centers = [17, 53, 89, 125];
  it('moves as soon as the ghost crosses the neighboring insertion point', () => {
    expect(queueDragTargetIndex(centers, 38, 0)).toBe(1);
    expect(queueDragTargetIndex(centers, 32, 1)).toBe(0);
  });
  it('keeps the new position for stationary input after rows change their animated positions', () => {
    let index = queueDragTargetIndex(centers, 40, 0);
    expect(index).toBe(1);
    for (let frame = 0; frame < 100; frame++) {
      index = queueDragTargetIndex(centers, 40, index);
      expect(index).toBe(1);
    }
  });
  it('does not alternate around the midpoint until the pointer deliberately crosses back', () => {
    let index = queueDragTargetIndex(centers, 38, 0);
    for (const y of [36, 35, 34, 36, 35, 34]) {
      index = queueDragTargetIndex(centers, y, index);
      expect(index).toBe(1);
    }
    expect(queueDragTargetIndex(centers, 32, index)).toBe(0);
  });
  it('handles fast motion across several slots and beyond either edge', () => {
    expect(queueDragTargetIndex(centers, 300, 0)).toBe(3);
    expect(queueDragTargetIndex(centers, -100, 3)).toBe(0);
    expect(queueDragTargetIndex([], 100, 0)).toBe(0);
  });
  it('preserves live arrivals and removes consumed inputs from an optimistic order', () => {
    expect(reconcileQueueOrder(['b', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(reconcileQueueOrder(['b', 'a'], ['a', 'c'])).toEqual(['a', 'c']);
  });
});
