import {
  ContextHardCutCompletedSchema,
  ContextHardCutFailedSchema,
  ContextHardCutStartedSchema,
  create,
  ErrorCode,
  type PersistedThreadEvent,
  PersistedThreadEventSchema,
  ThreadSnapshotSchema,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ThreadProjector, UnsupportedEventError } from './thread-projection.js';

const threadId = 'thread-1';

function projector(): ThreadProjector {
  const result = new ThreadProjector(threadId);
  result.applySnapshot(
    create(ThreadSnapshotSchema, {
      thread: { threadId, title: '会话', seq: 1n },
      messages: [],
      inputs: [],
      runs: [],
      devices: [],
      queueVersion: 0n,
    }),
    0n,
  );
  return result;
}

function event(seq: bigint, payload: PersistedThreadEvent['payload']) {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: create(PersistedThreadEventSchema, {
        eventId: `event-${seq}`,
        threadId,
        seq,
        payload,
      }),
    },
  });
}

function manualStarted(operationId = 'operation-1'): PersistedThreadEvent['payload'] {
  return {
    case: 'hardCutStarted',
    value: create(ContextHardCutStartedSchema, { runId: '', operationId }),
  };
}

function automaticStarted(runId = 'run-1'): PersistedThreadEvent['payload'] {
  return {
    case: 'hardCutStarted',
    value: create(ContextHardCutStartedSchema, { runId }),
  };
}

function manualCompleted(operationId = 'operation-1'): PersistedThreadEvent['payload'] {
  return {
    case: 'hardCutCompleted',
    value: create(ContextHardCutCompletedSchema, {
      runId: '',
      operationId,
      replacedSourceSeqs: [1n, 2n],
      recapIds: ['recap-1'],
      injectedMessageCount: 1,
    }),
  };
}

describe('manual and automatic hard-cut projection', () => {
  const events = [
    event(1n, manualStarted()),
    event(2n, automaticStarted()),
    event(3n, manualCompleted()),
    event(4n, {
      case: 'hardCutCompleted',
      value: create(ContextHardCutCompletedSchema, {
        runId: 'run-1',
        replacedSourceSeqs: [3n],
        recapIds: ['recap-auto'],
        injectedMessageCount: 1,
      }),
    }),
    event(5n, {
      case: 'hardCutFailed',
      value: create(ContextHardCutFailedSchema, {
        runId: '',
        operationId: 'operation-2',
        error: { code: ErrorCode.INTERNAL, message: '手动生成失败', retryable: false },
      }),
    }),
  ];

  it('uses stable operation ids and preserves automatic Run events', () => {
    const projected = projector();
    for (const item of events) projected.applyWatchResponse(item);

    expect(projected.state.hardCuts).toHaveLength(3);
    expect(projected.state.hardCuts[0]).toMatchObject({
      runId: '',
      operationId: 'operation-1',
      trigger: 'manual',
      status: 'completed',
      replacedSourceSeqs: [1n, 2n],
      recapIds: ['recap-1'],
    });
    expect(projected.state.hardCuts[1]).toMatchObject({
      runId: 'run-1',
      operationId: null,
      trigger: 'automatic',
      status: 'completed',
      recapIds: ['recap-auto'],
    });
    expect(projected.state.hardCuts[2]).toMatchObject({
      operationId: 'operation-2',
      trigger: 'manual',
      status: 'failed',
      error: '手动生成失败',
    });
  });

  it('deduplicates replayed events and supports reconnect replay from the persisted cursor', () => {
    const projected = projector();
    for (const item of [...events, ...events]) projected.applyWatchResponse(item);
    const expected = projected.state.hardCuts;

    const reconnected = projector();
    for (const item of events) reconnected.applyWatchResponse(item);

    expect(expected).toHaveLength(3);
    expect(reconnected.state.hardCuts).toEqual(expected);
    expect(reconnected.state.throughSeq).toBe(5n);
  });

  it('accepts a legacy automatic completion without a start event', () => {
    const projected = projector();
    projected.applyWatchResponse(
      event(1n, {
        case: 'hardCutCompleted',
        value: create(ContextHardCutCompletedSchema, {
          runId: 'run-legacy',
          replacedSourceSeqs: [8n],
          recapIds: ['recap-legacy'],
          injectedMessageCount: 1,
        }),
      }),
    );
    expect(projected.state.hardCuts[0]).toMatchObject({
      runId: 'run-legacy',
      operationId: null,
      trigger: 'automatic',
      status: 'completed',
    });
  });

  it('rejects an event without either automatic Run or manual operation identity', () => {
    const projected = projector();
    expect(() =>
      projected.applyWatchResponse(
        event(1n, {
          case: 'hardCutStarted',
          value: create(ContextHardCutStartedSchema, { runId: '' }),
        }),
      ),
    ).toThrow(UnsupportedEventError);
    expect(projected.state.throughSeq).toBe(0n);
    expect(projected.state.hardCuts).toEqual([]);
  });
});
