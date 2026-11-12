import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StorageLike } from './actions.js';
import { Composer } from './composer.js';
import { composerInputId, loadDraft, saveDraft } from './drafts.js';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('composer and draft isolation', () => {
  it('keeps main, right topic and local draft text under separate owners', () => {
    const storage = new MemoryStorage();
    saveDraft(storage, 'main-1', { id: 'main-draft', text: '主对话草稿' });
    saveDraft(storage, 'task-1', { id: 'topic-draft', text: '话题草稿' });
    saveDraft(storage, 'local:new-task', { id: 'new-draft', text: '首条要求' });

    expect(loadDraft(storage, 'main-1').text).toBe('主对话草稿');
    expect(loadDraft(storage, 'task-1').text).toBe('话题草稿');
    expect(loadDraft(storage, 'local:new-task').text).toBe('首条要求');
    expect(loadDraft(storage, 'task-2').text).toBe('');
  });

  it('uses unique DOM ids even when owner, thread and draft contain reserved characters', () => {
    const first = composerInputId({
      composerOwner: 'main',
      threadId: 'main:1',
      draftId: 'draft/1',
    });
    const second = composerInputId({
      composerOwner: 'topic',
      threadId: 'main:1',
      draftId: 'draft/1',
    });
    expect(first).not.toBe(second);
    expect(first).toContain('main:main%3A1:draft%2F1:message-input');

    const html = renderToStaticMarkup(
      createElement(Composer, {
        draft: { id: 'draft/1', text: '草稿' },
        busy: false,
        unavailable: false,
        composerOwner: 'topic',
        threadId: 'main:1',
        onChange: () => {},
        onSend: async () => {},
      }),
    );
    expect(html).toContain(`id="${second}"`);
    expect(html).toContain(`for="${second}"`);
  });
});
