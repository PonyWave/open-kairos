import {
  create,
  type Device,
  DeviceSchema,
  type GetThreadRequest,
  type GetThreadResponse,
  GetThreadResponseSchema,
  type Input,
  InputSchema,
  type Message,
  MessageSchema,
  type Recap,
  RecapSchema,
  type Run,
  RunSchema,
  type ThreadNotification,
  ThreadNotificationSchema,
  ThreadSnapshotCursorSchema,
  type ThreadSnapshot as ThreadSnapshotMessage,
  ThreadSnapshotSchema,
  toBinary,
} from '@kairos/contracts';
import { type EnvironmentRecord, EnvironmentStore } from '../devices/environment-store.js';
import {
  ensureMainEnvironment,
  type MainEnvironmentConfiguration,
} from '../devices/main-environment.js';
import { requirePositiveInteger, SessionError } from '../sessions/errors.js';
import type {
  SessionStore,
  SnapshotCollectionPosition,
  ThreadSnapshotPosition,
} from '../sessions/store.js';
import {
  toDevice,
  toEnvironment,
  toInput,
  toMessage,
  toRecap,
  toRun,
  toThread,
  toThreadNotification,
} from './convert.js';

export const defaultSnapshotPageBytes = 900 * 1024;
export const defaultSnapshotPageRecords = 100;

const categories = ['messages', 'inputs', 'runs', 'devices', 'recaps', 'notifications'] as const;
type Category = (typeof categories)[number];

type PageItem =
  | { category: 'messages'; cursor: bigint; value: Message }
  | { category: 'inputs'; cursor: bigint; value: Input }
  | { category: 'runs'; cursor: bigint; value: Run }
  | { category: 'devices'; cursor: bigint; value: Device }
  | { category: 'recaps'; cursor: bigint; value: Recap }
  | { category: 'notifications'; cursor: bigint; value: ThreadNotification };

export interface ThreadSnapshotPageOptions {
  maxBytes?: number;
  maxRecords?: number;
  mainEnvironment?: MainEnvironmentConfiguration;
  mainEnvironmentReady?: boolean;
  allowAutomationOnly?: boolean;
}

export function getThreadSnapshot(
  store: SessionStore,
  ownerId: string,
  request: GetThreadRequest,
  options: ThreadSnapshotPageOptions = {},
): GetThreadResponse {
  const thread = store.getThread(ownerId, request.threadId);
  if (thread.archivedAt) {
    throw new SessionError('not_found', 'The archived main conversation is not available.');
  }
  if (thread.automationOnly && options.allowAutomationOnly !== true) {
    throw new SessionError(
      'permission_denied',
      'An automation_only Thread requires its Automation history association.',
    );
  }
  const maxBytes = options.maxBytes ?? defaultSnapshotPageBytes;
  const maxRecords = options.maxRecords ?? defaultSnapshotPageRecords;
  const limit = requirePositiveInteger(request.limit ?? maxRecords, 'limit', maxRecords);
  const latest = BigInt(store.latestEventSequence(thread.threadId));
  const throughSeq = request.cursor?.throughSeq ?? latest;
  const position = request.cursor
    ? fromCursor(request, latest)
    : store.getThreadSnapshotBounds(ownerId, thread.threadId);
  const firstPage = request.cursor === undefined;
  let mainEnvironment: EnvironmentRecord | undefined;
  if (thread.threadType === 'main' && options.mainEnvironment) {
    const envId = ensureMainEnvironment(store.database, ownerId, options.mainEnvironment);
    mainEnvironment = new EnvironmentStore(store.database).get(ownerId, envId);
  }
  const snapshot = create(ThreadSnapshotSchema, {
    ...(firstPage
      ? {
          thread: toThread(thread),
          queueVersion: BigInt(store.queueVersion(thread.threadId)),
          ...(mainEnvironment
            ? {
                mainEnvironment: {
                  ...toEnvironment(mainEnvironment),
                  ...(options.mainEnvironmentReady === false
                    ? { statusReason: '主环境当前不可用。' }
                    : {}),
                },
              }
            : {}),
        }
      : {}),
  });
  let recordCount = 0;
  let stopped = false;

  for (const category of categories) {
    if (stopped) break;
    const collection = position[category];
    if (collection.afterRowid >= collection.maxRowid) continue;
    const fetchLimit = limit - recordCount + 1;
    const items = readItems(store, ownerId, thread.threadId, category, collection, fetchLimit);
    if (items.length === 0) {
      collection.afterRowid = collection.maxRowid;
      continue;
    }
    let consumedAll = true;
    for (const item of items) {
      if (recordCount >= limit) {
        consumedAll = false;
        stopped = true;
        break;
      }
      const previous = collection.afterRowid;
      collection.afterRowid = item.cursor;
      appendItem(snapshot, item);
      const candidate = makeResponse(snapshot, throughSeq, thread.threadId, position, true);
      if (toBinary(GetThreadResponseSchema, candidate).length > maxBytes) {
        collection.afterRowid = previous;
        removeItem(snapshot, item.category);
        if (recordCount === 0) {
          throw new SessionError(
            'internal',
            'A Thread snapshot record exceeds the configured page byte limit.',
          );
        }
        consumedAll = false;
        stopped = true;
        break;
      }
      recordCount += 1;
    }
    if (consumedAll && items.length < fetchLimit) {
      collection.afterRowid = collection.maxRowid;
    }
  }

  const hasMore = categories.some(
    (category) => position[category].afterRowid < position[category].maxRowid,
  );
  const response = makeResponse(snapshot, throughSeq, thread.threadId, position, hasMore);
  if (toBinary(GetThreadResponseSchema, response).length > maxBytes) {
    throw new SessionError(
      'internal',
      'A Thread snapshot record exceeds the configured page byte limit.',
    );
  }
  return response;
}

function fromCursor(request: GetThreadRequest, latest: bigint): ThreadSnapshotPosition {
  const cursor = request.cursor;
  if (!cursor || cursor.threadId !== request.threadId || cursor.throughSeq > latest) {
    throw new SessionError('invalid_argument', 'The Thread snapshot cursor is not valid.');
  }
  const collection = (category: Category): SnapshotCollectionPosition => {
    const value = cursor[category];
    if (!value && (category === 'recaps' || category === 'notifications')) {
      return { afterRowid: 0n, maxRowid: 0n };
    }
    if (!value || value.afterRowid > value.maxRowid) {
      throw new SessionError('invalid_argument', 'The Thread snapshot cursor is not valid.');
    }
    return { afterRowid: value.afterRowid, maxRowid: value.maxRowid };
  };
  return {
    messages: collection('messages'),
    inputs: collection('inputs'),
    runs: collection('runs'),
    devices: collection('devices'),
    recaps: collection('recaps'),
    notifications: collection('notifications'),
  };
}

function readItems(
  store: SessionStore,
  ownerId: string,
  threadId: string,
  category: Category,
  position: SnapshotCollectionPosition,
  limit: number,
): PageItem[] {
  switch (category) {
    case 'messages':
      return store.listThreadSnapshotMessages(ownerId, threadId, position, limit).map((record) => ({
        category,
        cursor: record.cursor,
        value: create(MessageSchema, toMessage(record.value)),
      }));
    case 'inputs':
      return store.listThreadSnapshotInputs(ownerId, threadId, position, limit).map((record) => ({
        category,
        cursor: record.cursor,
        value: create(InputSchema, toInput(record.value)),
      }));
    case 'runs':
      return store.listThreadSnapshotRuns(ownerId, threadId, position, limit).map((record) => ({
        category,
        cursor: record.cursor,
        value: create(RunSchema, toRun(record.value)),
      }));
    case 'devices':
      return store.listThreadSnapshotDevices(ownerId, threadId, position, limit).map((record) => ({
        category,
        cursor: record.cursor,
        value: create(DeviceSchema, toDevice(record.value)),
      }));
    case 'recaps':
      return store.listThreadSnapshotRecaps(ownerId, threadId, position, limit).map((record) => ({
        category,
        cursor: record.cursor,
        value: create(RecapSchema, toRecap({ ...record.value, cursor: record.cursor })),
      }));
    case 'notifications':
      return store
        .listThreadSnapshotNotifications(ownerId, threadId, position, limit)
        .map((record) => ({
          category,
          cursor: record.cursor,
          value: create(ThreadNotificationSchema, toThreadNotification(record.value)),
        }));
  }
}

function appendItem(snapshot: ThreadSnapshotMessage, item: PageItem): void {
  switch (item.category) {
    case 'messages':
      snapshot.messages.push(item.value);
      return;
    case 'inputs':
      snapshot.inputs.push(item.value);
      return;
    case 'runs':
      snapshot.runs.push(item.value);
      return;
    case 'devices':
      snapshot.devices.push(item.value);
      return;
    case 'recaps':
      snapshot.recaps.push(item.value);
      return;
    case 'notifications':
      snapshot.notifications.push(item.value);
  }
}

function removeItem(snapshot: ThreadSnapshotMessage, category: Category): void {
  snapshot[category].pop();
}

function makeResponse(
  snapshot: ThreadSnapshotMessage,
  throughSeq: bigint,
  threadId: string,
  position: ThreadSnapshotPosition,
  hasMore: boolean,
): GetThreadResponse {
  return create(GetThreadResponseSchema, {
    snapshot,
    throughSeq,
    hasMore,
    ...(hasMore
      ? {
          nextCursor: create(ThreadSnapshotCursorSchema, {
            threadId,
            throughSeq,
            messages: position.messages,
            inputs: position.inputs,
            runs: position.runs,
            devices: position.devices,
            recaps: position.recaps,
            notifications: position.notifications,
          }),
        }
      : {}),
  });
}
