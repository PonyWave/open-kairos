/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';
import { ActionConflictError, ClientActionStore, type StorageLike } from './actions.js';
import { clearDraft, loadDraft, newDraft, saveDraft } from './drafts.js';

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

describe('ClientActionStore', () => {
  it('reuses an action id and original payload across restored client state', () => {
    const storage = new MemoryStorage();
    const payload = { threadId: 'thread-1', text: 'hello', mode: 2 };
    const first = new ClientActionStore(storage);
    const record = first.begin('send:draft-1', 'sendMessage', payload);
    expect(first.begin('send:draft-1', 'sendMessage', payload)).toEqual(record);

    const restored = new ClientActionStore(storage);
    expect(restored.begin('send:draft-1', 'sendMessage', payload)).toEqual(record);
    let conflict: unknown;
    try {
      restored.begin('send:draft-1', 'sendMessage', { ...payload, mode: 1 });
    } catch (cause) {
      conflict = cause;
    }
    expect(conflict).toBeInstanceOf(ActionConflictError);
    expect((conflict as ActionConflictError).actionId).toBe(record.id);
    expect(restored.get('send:draft-1')).toEqual(record);
  });

  it('starts a new action after success or a terminal not-executed failure', () => {
    const store = new ClientActionStore();
    const first = store.begin('rename:1', 'renameThread', { title: 'title' });
    store.succeed('rename:1', first.id);
    const succeeded = store.begin('rename:1', 'renameThread', { title: 'title' });
    expect(succeeded.id).not.toBe(first.id);
    store.succeed('rename:1', succeeded.id);

    const rejected = store.begin('rename:1', 'renameThread', { title: 'old title' });
    store.fail('rename:1', rejected.id);
    const next = store.begin('rename:1', 'renameThread', { title: 'new title' });
    expect(next.id).not.toBe(rejected.id);
    expect(next.payload).toEqual({ title: 'new title' });
  });

  it('does not clear an action when the terminal id does not match', () => {
    const store = new ClientActionStore();
    const record = store.begin('rename:1', 'renameThread', { title: 'title' });
    store.fail('rename:1', 'another-id');
    expect(store.get('rename:1')).toEqual(record);
  });

  it('restores the pending record when terminal cleanup cannot be persisted', () => {
    const storage = new MemoryStorage();
    const store = new ClientActionStore(storage);
    const record = store.begin('rename:1', 'renameThread', { title: 'title' });
    storage.setItem = () => {
      throw new Error('storage full');
    };
    expect(() => store.fail('rename:1', record.id)).toThrow('storage full');
    expect(store.get('rename:1')).toEqual(record);
    expect(new ClientActionStore(storage).get('rename:1')).toEqual(record);
  });

  it('rolls back a new record when initial persistence fails', () => {
    const storage = new MemoryStorage();
    const store = new ClientActionStore(storage);
    storage.setItem = () => {
      throw new Error('storage full');
    };
    expect(() => store.begin('rename:1', 'renameThread', { title: 'title' })).toThrow(
      'storage full',
    );
    expect(store.pending()).toEqual([]);
    expect(new ClientActionStore(storage).pending()).toEqual([]);
  });

  it('restores the completed record when success cleanup cannot be persisted', () => {
    const storage = new MemoryStorage();
    const store = new ClientActionStore(storage);
    const record = store.begin('rename:1', 'renameThread', { title: 'title' });
    storage.setItem = () => {
      throw new Error('storage full');
    };
    expect(() => store.succeed('rename:1', record.id)).toThrow('storage full');
    expect(store.get('rename:1')).toEqual(record);
    expect(new ClientActionStore(storage).get('rename:1')).toEqual(record);
  });

  it('rejects malformed persisted records instead of ignoring them', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'kairos.client-actions.v2',
      '{"send":{"id":"","key":"send","kind":"sendMessage","fingerprint":"x","payload":{}}}',
    );
    expect(() => new ClientActionStore(storage)).toThrow('本地操作记录格式无效');
  });
});

describe('message drafts', () => {
  it('retains unsent text and its stable draft id across clients', () => {
    const storage = new MemoryStorage();
    const draft = { ...newDraft(), text: '尚未发送' };
    saveDraft(storage, 'thread-1', draft);
    expect(loadDraft(storage, 'thread-1')).toEqual(draft);
    clearDraft(storage, 'thread-1');
    const next = loadDraft(storage, 'thread-1');
    expect(next.text).toBe('');
    expect(next.id).not.toBe(draft.id);
  });
});
