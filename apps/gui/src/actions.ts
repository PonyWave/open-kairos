import { randomId } from './random.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ActionKind =
  | 'createThread'
  | 'renameThread'
  | 'sendMessage'
  | 'deleteAttachment'
  | 'reviseMessage'
  | 'editInput'
  | 'removeInput'
  | 'reorderInputs'
  | 'cancelRun'
  | 'continueRun'
  | 'rerun'
  | 'reloadResources'
  | 'compactContext'
  | 'startNewMain'
  | 'createAutomation'
  | 'updateAutomation'
  | 'deleteAutomation'
  | 'runAutomationNow';

const actionKinds = new Set<ActionKind>([
  'createThread',
  'renameThread',
  'sendMessage',
  'deleteAttachment',
  'reviseMessage',
  'editInput',
  'removeInput',
  'reorderInputs',
  'cancelRun',
  'continueRun',
  'rerun',
  'reloadResources',
  'compactContext',
  'startNewMain',
  'createAutomation',
  'updateAutomation',
  'deleteAutomation',
  'runAutomationNow',
]);

export interface ClientActionRecord {
  id: string;
  key: string;
  kind: ActionKind;
  fingerprint: string;
  payload: unknown;
}

export class ActionConflictError extends Error {
  constructor(
    readonly key: string,
    readonly actionId: string,
  ) {
    super(`操作 ${key} 的编号 ${actionId} 已绑定不同参数。请核对状态或重试原操作。`);
    this.name = 'ActionConflictError';
  }
}

export class ActionPayloadError extends Error {
  constructor() {
    super('本地持久化操作参数无效，未发送请求。');
    this.name = 'ActionPayloadError';
  }
}

export class ClientActionStore {
  private readonly records = new Map<string, ClientActionRecord>();

  constructor(
    private readonly storage?: StorageLike,
    private readonly storageKey = 'kairos.client-actions.v2',
  ) {
    this.restore();
  }

  begin(key: string, kind: ActionKind, payload: unknown): ClientActionRecord {
    const fingerprint = JSON.stringify({ kind, payload });
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ActionConflictError(key, existing.id);
      return existing;
    }
    const record: ClientActionRecord = {
      id: randomId(),
      key,
      kind,
      fingerprint,
      payload,
    };
    this.records.set(key, record);
    try {
      this.persist();
    } catch (cause) {
      this.records.delete(key);
      throw cause;
    }
    return record;
  }

  get(key: string): ClientActionRecord | undefined {
    return this.records.get(key);
  }

  pending(): ClientActionRecord[] {
    return [...this.records.values()];
  }

  succeed(key: string, id: string): void {
    const existing = this.records.get(key);
    if (!existing || existing.id !== id) return;
    this.records.delete(key);
    try {
      this.persist();
    } catch (cause) {
      this.records.set(key, existing);
      throw cause;
    }
  }

  fail(key: string, id: string): void {
    const existing = this.records.get(key);
    if (!existing || existing.id !== id) return;
    this.records.delete(key);
    try {
      this.persist();
    } catch (cause) {
      this.records.set(key, existing);
      throw cause;
    }
  }

  private restore(): void {
    if (!this.storage) return;
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('本地操作记录格式无效。');
    }
    for (const [key, record] of Object.entries(value)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('本地操作记录格式无效。');
      }
      const id = Reflect.get(record, 'id');
      const recordKey = Reflect.get(record, 'key');
      const kind = Reflect.get(record, 'kind');
      const fingerprint = Reflect.get(record, 'fingerprint');
      if (
        typeof id !== 'string' ||
        !id ||
        recordKey !== key ||
        typeof kind !== 'string' ||
        !actionKinds.has(kind as ActionKind) ||
        typeof fingerprint !== 'string' ||
        !Reflect.has(record, 'payload')
      ) {
        throw new Error('本地操作记录格式无效。');
      }
      this.records.set(key, {
        id,
        key,
        kind: kind as ActionKind,
        fingerprint,
        payload: Reflect.get(record, 'payload'),
      });
    }
  }

  private persist(): void {
    if (!this.storage) return;
    this.storage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.records)));
  }
}

export function browserStorage(): StorageLike | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}
