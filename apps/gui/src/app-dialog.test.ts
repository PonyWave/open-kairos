import { describe, expect, it } from 'vitest';
import { dialogTrapIndex } from './app-dialog.js';

describe('dialog Tab trap', () => {
  it('wraps focus from the last control back to the first', () => {
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: false }, 2, 3)).toBe(0);
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: false }, 0, 1)).toBe(0);
  });

  it('wraps focus from the first control to the last with Shift', () => {
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: true }, 0, 3)).toBe(2);
  });

  it('leaves middle controls, unknown focus and other keys to native handling', () => {
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: false }, 1, 3)).toBeNull();
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: true }, 1, 3)).toBeNull();
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: false }, -1, 3)).toBeNull();
    expect(dialogTrapIndex({ key: 'Enter', shiftKey: false }, 2, 3)).toBeNull();
    expect(dialogTrapIndex({ key: 'Tab', shiftKey: false }, 0, 0)).toBeNull();
  });
});
