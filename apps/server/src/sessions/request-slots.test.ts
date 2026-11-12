import { describe, expect, it } from 'vitest';
import { RequestSlots } from './request-slots.js';

describe('model request slots', () => {
  it('reserves a released slot for its waiter before a new request can acquire it', async () => {
    const slots = new RequestSlots(1);
    const signal = new AbortController().signal;
    const releaseFirst = await slots.acquire(signal);
    const admitted: string[] = [];
    const second = slots.acquire(signal).then((release) => {
      admitted.push('second');
      return release;
    });
    releaseFirst();
    const third = slots.acquire(signal).then((release) => {
      admitted.push('third');
      return release;
    });
    const releaseSecond = await second;
    expect(admitted).toEqual(['second']);
    releaseSecond();
    releaseSecond();
    const releaseThird = await third;
    expect(admitted).toEqual(['second', 'third']);
    releaseThird();
    const releaseFinal = await slots.acquire(signal);
    releaseFinal();
  });

  it('removes a cancelled waiter without consuming or releasing an active request slot', async () => {
    const slots = new RequestSlots(1);
    const signal = new AbortController().signal;
    const releaseFirst = await slots.acquire(signal);
    const cancelled = new AbortController();
    const second = slots.acquire(cancelled.signal);
    const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    cancelled.abort();
    await rejection;
    let admitted = false;
    const third = slots.acquire(signal).then((release) => {
      admitted = true;
      return release;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    releaseFirst();
    const releaseThird = await third;
    expect(admitted).toBe(true);
    releaseThird();
  });

  it('releases a transferred slot when its waiter is cancelled before resuming', async () => {
    const slots = new RequestSlots(1);
    const signal = new AbortController().signal;
    const releaseFirst = await slots.acquire(signal);
    const cancelled = new AbortController();
    const second = slots.acquire(cancelled.signal);
    const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const third = slots.acquire(signal);
    releaseFirst();
    cancelled.abort();
    await rejection;
    const releaseThird = await third;
    releaseThird();
    const releaseFinal = await slots.acquire(signal);
    releaseFinal();
  });
});
