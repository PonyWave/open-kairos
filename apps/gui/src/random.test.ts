import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './random.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('randomId', () => {
  it('uses crypto.randomUUID when available', () => {
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('falls back to getRandomValues in non-secure contexts', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        array.fill(0xab);
        return array;
      },
    });
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
