import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  DelegationReferenceSchema,
  InputMode,
  InputSchema,
  InputStatus,
  type Message,
  MessageRole,
  MessageSchema,
  MessageSource,
  RecapSchema,
  RecapValidity,
  type Run,
  RunSchema,
  RunStatus,
  ThreadSchema,
  ThreadSnapshotSchema,
  ToolCallSchema,
  ToolResultStatus,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { projectConversationDisplay } from './conversation-display-projection.js';
import { projectConversation } from './response-projection.js';
import { ThreadProjector } from './thread-projection.js';

const threadId = 'thread-1';

function message(messageId: string, seq: bigint, runId?: string): Message {
  return create(MessageSchema, {
    messageId,
    threadId,
    agentId: 'thread',
    seq,
    role: runId ? MessageRole.ASSISTANT : MessageRole.USER,
    content: messageId,
    ...(runId ? { runId } : {}),
  });
}

function run(
  runId: string,
  status: RunStatus,
  options: {
    inputIds?: string[];
    rerunFromMessageSeq?: bigint;
    supersededByRunId?: string;
    createdAt?: { seconds: bigint; nanos: number };
  } = {},
): Run {
  return create(RunSchema, {
    runId,
    threadId,
    agentId: 'thread',
    status,
    ...options,
  });
}

function transient(messageId: string, runId: string) {
  return {
    messageId,
    runId,
    deltaSeq: 1n,
    contentBlocks: [
      create(ContentBlockSchema, {
        type: ContentBlockType.TEXT,
        blockIndex: 0,
        text: messageId,
      }),
    ],
  };
}

describe('conversation response projection', () => {
  it('indexes 10000 persisted Run positions without repeatedly scanning the message history', () => {
    const count = 10_000;
    let historyRunReads = 0;
    const messages = Array.from({ length: count }, (_, index) => {
      const runId = `run-${index}`;
      const entry = message(`response-${index}`, BigInt(index + 1), runId);
      Object.defineProperty(entry, 'runId', {
        enumerable: true,
        get: () => {
          historyRunReads += 1;
          return runId;
        },
      });
      return entry;
    });
    const runs = Array.from({ length: count }, (_, index) => run(`run-${index}`, RunStatus.FAILED));
    const items = projectConversation({ threadId, messages, runs, transientResponses: [] });

    expect(items).toHaveLength(count * 2);
    expect(items.slice(0, 4).map((item) => item.key)).toEqual([
      'response-0',
      'run-outcome:run-0',
      'response-1',
      'run-outcome:run-1',
    ]);
    expect(items.at(-1)?.key).toBe(`run-outcome:run-${count - 1}`);
    expect(historyRunReads).toBeLessThanOrEqual(count * 3);
  });

  it('indexes 10000 unanchored Run times with one history traversal and logarithmic lookups', () => {
    const count = 10_000;
    let historyTimeReads = 0;
    let timestampSecondsReads = 0;
    const messages = Array.from({ length: count }, (_, index) => {
      const entry = message(`response-${index}`, BigInt(index + 1));
      const createdAt = {
        $typeName: 'google.protobuf.Timestamp' as const,
        get seconds() {
          timestampSecondsReads += 1;
          return BigInt(index);
        },
        nanos: 0,
      };
      Object.defineProperty(entry, 'createdAt', {
        enumerable: true,
        get: () => {
          historyTimeReads += 1;
          return createdAt;
        },
      });
      return entry;
    });
    const runs = Array.from({ length: count }, (_, index) =>
      run(`run-${index}`, RunStatus.FAILED, { createdAt: { seconds: BigInt(index), nanos: 0 } }),
    );
    const items = projectConversation({ threadId, messages, runs, transientResponses: [] });

    expect(items).toHaveLength(count * 2);
    expect(items.slice(0, 4).map((item) => item.key)).toEqual([
      'response-0',
      'run-outcome:run-0',
      'response-1',
      'run-outcome:run-1',
    ]);
    expect(items.at(-1)?.key).toBe(`run-outcome:run-${count - 1}`);
    expect(historyTimeReads).toBe(count);
    expect(timestampSecondsReads).toBeLessThanOrEqual(
      count * (5 + 2 * Math.ceil(Math.log2(count + 1))),
    );
  });

  it('shows only the current Attempt and excludes superseded outcomes and temporary output', () => {
    const anchor = message('user-1', 1n);
    const oldResponse = create(MessageSchema, {
      ...message('old-response', 2n, 'run-old'),
      supersededByRunId: 'run-new',
    });
    const currentResponse = message('current-response', 2n, 'run-new');
    const items = projectConversation({
      threadId,
      messages: [anchor, oldResponse, currentResponse],
      transientResponses: [
        transient('old-temporary', 'run-old'),
        transient('new-temporary', 'run-new'),
      ],
      runs: [
        run('run-old', RunStatus.FAILED, { supersededByRunId: 'run-new' }),
        run('run-new', RunStatus.RUNNING),
      ],
    });

    expect(items.map((item) => item.key)).toEqual([
      'user-1',
      'current-response',
      'new-temporary',
      'pending-agent:run:run-new',
    ]);
    const temporary = items.find((item) => item.key === 'new-temporary');
    expect(temporary?.kind).toBe('message');
    if (temporary?.kind === 'message') {
      expect(temporary.value.streaming).toBe(true);
      expect(temporary.value.message.runId).toBe('run-new');
    }
  });

  it('uses the associated Run timestamp for streaming messages', () => {
    const createdAt = {
      $typeName: 'google.protobuf.Timestamp' as const,
      seconds: 10n,
      nanos: 0,
    };
    const startedAt = { ...createdAt, seconds: 20n };
    const items = projectConversation({
      threadId,
      messages: [],
      transientResponses: [
        transient('temporary-started', 'run-started'),
        transient('temporary-created', 'run-created'),
      ],
      runs: [
        create(RunSchema, {
          ...run('run-started', RunStatus.RUNNING, { createdAt }),
          startedAt,
        }),
        run('run-created', RunStatus.RUNNING, { createdAt }),
      ],
    });

    expect(
      items.map((item) =>
        item.kind === 'message' ? item.value.message.createdAt?.seconds : undefined,
      ),
    ).toEqual([20n, 10n, undefined]);
  });

  it('places one failed Run outcome after its last associated response', () => {
    const items = projectConversation({
      threadId,
      messages: [
        message('user-1', 1n),
        message('response-1', 2n, 'run-1'),
        message('response-2', 3n, 'run-1'),
        message('later-user', 4n),
      ],
      transientResponses: [],
      runs: [run('run-1', RunStatus.FAILED)],
    });

    expect(items.map((item) => item.key)).toEqual([
      'user-1',
      'response-1',
      'response-2',
      'run-outcome:run-1',
      'later-user',
    ]);
  });

  it('uses original Input and Rerun anchors when a Run has no assistant message', () => {
    const firstInput = create(MessageSchema, {
      ...message('user-1', 1n),
      sourceInputId: 'input-1',
    });
    const unrelated = message('unrelated', 2n, 'run-other');
    const rerunAnchor = message('user-2', 3n);
    const items = projectConversation({
      threadId,
      messages: [firstInput, unrelated, rerunAnchor],
      transientResponses: [],
      runs: [
        run('failed-input', RunStatus.FAILED, { inputIds: ['input-1'] }),
        run('failed-rerun', RunStatus.CANCELLED, { rerunFromMessageSeq: 3n }),
      ],
    });

    expect(items.map((item) => item.key)).toEqual([
      'user-1',
      'run-outcome:failed-input',
      'unrelated',
      'user-2',
      'run-outcome:failed-rerun',
    ]);
  });

  it('anchors zero-output Rerun outcomes to the root Agent user message across Agent sequences', () => {
    const mainUser = message('a-main-user', 1n);
    const subagentResponse = create(MessageSchema, {
      ...message('z-subagent-response', 1n, 'subagent-run'),
      agentId: 'subagent-a',
    });
    const later = message('later', 2n);

    for (const status of [RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.INTERRUPTED]) {
      const runId = `rerun-${status}`;
      const items = projectConversation({
        threadId,
        messages: [mainUser, subagentResponse, later],
        transientResponses: [],
        runs: [run(runId, status, { rerunFromMessageSeq: 1n })],
      });

      expect(items.map((item) => item.key)).toEqual([
        'a-main-user',
        `run-outcome:${runId}`,
        'later',
      ]);
    }
  });

  it('inserts unanchored outcomes by Run time and runId without borrowing an assistant', () => {
    const timestamp = (seconds: bigint) => ({
      $typeName: 'google.protobuf.Timestamp' as const,
      seconds,
      nanos: 0,
    });
    const first = create(MessageSchema, {
      ...message('first', 1n),
      createdAt: timestamp(10n),
    });
    const second = create(MessageSchema, {
      ...message('second', 2n),
      createdAt: timestamp(20n),
    });
    const items = projectConversation({
      threadId,
      messages: [first, second],
      transientResponses: [],
      runs: [
        run('run-b', RunStatus.FAILED, { createdAt: timestamp(15n) }),
        run('run-a', RunStatus.INTERRUPTED, { createdAt: timestamp(15n) }),
        create(RunSchema, { ...run('foreign', RunStatus.FAILED), threadId: 'thread-2' }),
      ],
    });

    expect(items.map((item) => item.key)).toEqual([
      'first',
      'run-outcome:run-a',
      'run-outcome:run-b',
      'second',
    ]);
  });

  it('locates the first later message in its original order with nanosecond precision', () => {
    const timestamp = (seconds: bigint, nanos: number) => ({
      $typeName: 'google.protobuf.Timestamp' as const,
      seconds,
      nanos,
    });
    const items = projectConversation({
      threadId,
      messages: [
        message('no-time', 1n),
        create(MessageSchema, {
          ...message('first-later', 2n),
          createdAt: timestamp(10n, 20),
        }),
        create(MessageSchema, {
          ...message('earlier-after-later', 3n),
          createdAt: timestamp(1n, 0),
        }),
        create(MessageSchema, {
          ...message('same-time', 4n),
          createdAt: timestamp(10n, 20),
        }),
        create(MessageSchema, {
          ...message('one-nanosecond-later', 5n),
          createdAt: timestamp(10n, 21),
        }),
      ],
      transientResponses: [],
      runs: [
        run('before', RunStatus.FAILED, { createdAt: timestamp(10n, 19) }),
        run('same', RunStatus.FAILED, { createdAt: timestamp(10n, 20) }),
        run('after', RunStatus.FAILED, { createdAt: timestamp(10n, 21) }),
      ],
    });

    expect(items.map((item) => item.key)).toEqual([
      'no-time',
      'run-outcome:before',
      'first-later',
      'earlier-after-later',
      'same-time',
      'run-outcome:same',
      'one-nanosecond-later',
      'run-outcome:after',
    ]);
  });

  it.each([
    { seconds: 10n, nanos: -1 },
    { seconds: 10n, nanos: 1_000_000_000 },
    { seconds: 10n, nanos: Number.NaN },
    { seconds: 10n ** 30n, nanos: 0 },
  ])(
    'ignores invalid message times and appends unanchored Runs with invalid times (%o)',
    (time) => {
      const invalidTime = { $typeName: 'google.protobuf.Timestamp' as const, ...time };
      const items = projectConversation({
        threadId,
        messages: [
          create(MessageSchema, { ...message('invalid-time', 1n), createdAt: invalidTime }),
          create(MessageSchema, {
            ...message('valid-time', 2n),
            createdAt: { $typeName: 'google.protobuf.Timestamp', seconds: 10n, nanos: 0 },
          }),
        ],
        transientResponses: [],
        runs: [
          run('invalid-run', RunStatus.FAILED, { createdAt: time }),
          run('no-time-run', RunStatus.FAILED),
          run('valid-run', RunStatus.FAILED, { createdAt: { seconds: 5n, nanos: 0 } }),
        ],
      });

      expect(items.map((item) => item.key)).toEqual([
        'invalid-time',
        'run-outcome:valid-run',
        'valid-time',
        'run-outcome:invalid-run',
        'run-outcome:no-time-run',
      ]);
    },
  );

  it('keeps exact delegation associations across Runs, same seqs and event restoration', () => {
    const sourceCall = (messageId: string, agentId: string, runId: string) =>
      create(MessageSchema, {
        ...message(messageId, 1n, runId),
        agentId,
        toolCalls: [
          create(ToolCallSchema, {
            toolCallId: 'shared-call',
            toolName: 'subagent',
            argumentsJson: '{"task":"work"}',
          }),
        ],
      });
    const backgroundResponse = (messageId: string, sourceAgentId: string, runId: string) =>
      create(MessageSchema, {
        ...message(messageId, 2n, runId),
        role: MessageRole.USER,
        source: MessageSource.SUBAGENT_RESPONSE,
        delegation: create(DelegationReferenceSchema, {
          sourceThreadId: threadId,
          sourceAgentId,
          sourceToolCallId: 'shared-call',
        }),
      });
    const records = [
      sourceCall('root-call', 'thread', 'run-root-call'),
      sourceCall('child-call', 'subagent-a', 'run-child-call'),
      backgroundResponse('root-response', 'thread', 'run-root-delivery'),
      backgroundResponse('child-response', 'subagent-a', 'run-child-delivery'),
    ];
    const projector = new ThreadProjector(threadId);
    projector.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId, title: '委派恢复', seq: 1n }),
      }),
      0n,
    );
    records.forEach((record, index) => {
      projector.applyWatchResponse(
        create(WatchThreadResponseSchema, {
          payload: {
            case: 'event',
            value: {
              eventId: `message-${index}`,
              threadId,
              seq: BigInt(index + 1),
              payload: { case: 'messageCommitted', value: { message: record } },
            },
          },
        }),
      );
    });
    const duplicate = create(WatchThreadResponseSchema, {
      payload: {
        case: 'event',
        value: {
          eventId: 'duplicate-delivery',
          threadId,
          seq: 4n,
          payload: {
            case: 'messageCommitted',
            value: {
              message: backgroundResponse('child-response', 'subagent-a', 'run-child-delivery'),
            },
          },
        },
      },
    });
    projector.applyWatchResponse(duplicate);
    projector.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId, title: '委派恢复', seq: 1n }),
        messages: records,
      }),
      4n,
    );

    const items = projectConversation({
      threadId,
      messages: projector.state.snapshot?.messages ?? [],
      transientResponses: [],
      runs: [],
    });
    expect(items.map((item) => item.key)).toEqual(['root-call', 'child-response', 'root-response']);
    const associations = new Map(
      items.flatMap((item) =>
        item.kind === 'message'
          ? [[item.value.message.messageId, item.value.delegationCall?.messageId ?? null] as const]
          : [],
      ),
    );
    expect(associations.get('root-response')).toBe('root-call');
    expect(associations.get('child-response')).toBe('child-call');
    expect(associations.get('root-call')).toBeNull();
    expect(records[2]?.runId).not.toBe(records[0]?.runId);
    expect(records[3]?.runId).not.toBe(records[1]?.runId);
  });

  it('removes terminal transient output and filters terminal temporary responses defensively', () => {
    const projector = new ThreadProjector(threadId);
    projector.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId, title: '测试', seq: 1n }),
      }),
      0n,
    );
    for (const [messageId, runId] of [
      ['temporary-1', 'run-1'],
      ['temporary-2', 'run-2'],
    ] as const) {
      projector.applyWatchResponse(
        create(WatchThreadResponseSchema, {
          payload: {
            case: 'textDelta',
            value: { threadId, messageId, runId, deltaSeq: 1n, text: messageId },
          },
        }),
      );
    }
    expect(projector.state.transientResponses.map((response) => response.runId)).toEqual([
      'run-1',
      'run-2',
    ]);

    projector.applyWatchResponse(
      create(WatchThreadResponseSchema, {
        payload: {
          case: 'event',
          value: {
            eventId: 'failed-run-1',
            threadId,
            seq: 1n,
            payload: {
              case: 'runChanged',
              value: { run: run('run-1', RunStatus.FAILED) },
            },
          },
        },
      }),
    );
    projector.applyWatchResponse(
      create(WatchThreadResponseSchema, {
        payload: {
          case: 'textDelta',
          value: {
            threadId,
            messageId: 'late-temporary',
            runId: 'run-1',
            deltaSeq: 1n,
            text: '迟到内容',
          },
        },
      }),
    );

    expect(projector.state.transientResponses.map((response) => response.messageId)).toEqual([
      'temporary-2',
    ]);
    const items = projectConversation({
      threadId,
      messages: [],
      transientResponses: [transient('leftover', 'run-1'), transient('active', 'run-2')],
      runs: [run('run-1', RunStatus.FAILED), run('run-2', RunStatus.RUNNING)],
    });
    expect(items.map((item) => item.key)).toEqual([
      'active',
      'run-outcome:run-1',
      'pending-agent:run:run-2',
    ]);
  });
});

describe('mixed operation conversation projection', () => {
  function operationMessage(
    messageId: string,
    seq: bigint,
    toolName: string,
    thinking?: string,
    text = '',
  ) {
    const blockCount = (thinking === undefined ? 0 : 1) + (text ? 1 : 0);
    return create(MessageSchema, {
      messageId,
      threadId,
      agentId: 'thread',
      seq,
      runId: 'run-1',
      role: MessageRole.ASSISTANT,
      content: text,
      contentBlocks: [
        ...(thinking === undefined
          ? []
          : [{ type: ContentBlockType.THINKING, blockIndex: 0, text: thinking }]),
        ...(text
          ? [{ type: ContentBlockType.TEXT, blockIndex: thinking === undefined ? 0 : 1, text }]
          : []),
      ],
      toolCalls: [
        create(ToolCallSchema, {
          toolCallId: `${toolName}-${messageId}`,
          toolName,
          argumentsJson: '{}',
          blockIndex: blockCount,
        }),
      ],
    });
  }

  function operationResult(seq: bigint, callId: string) {
    return create(MessageSchema, {
      messageId: `result-${callId}`,
      threadId,
      agentId: 'thread',
      seq,
      runId: 'run-1',
      role: MessageRole.TOOL,
      toolCallId: callId,
      toolName: callId.split('-')[0] ?? '',
      content: '{}',
    });
  }

  function displayFor(items: ReturnType<typeof projectConversation>, messageId: string) {
    const item = items.find(
      (candidate) =>
        candidate.kind === 'message' && candidate.value.message.messageId === messageId,
    );
    if (item?.kind !== 'message') throw new Error(`Missing ${messageId}.`);
    return item.value;
  }

  it('joins three alternating Thinking and tool messages across associated results', () => {
    const first = operationMessage('first', 1n, 'bash', '思考一');
    const second = operationMessage('second', 3n, 'read', '思考二');
    const third = operationMessage('third', 5n, 'write', '思考三');
    const items = projectConversation({
      threadId,
      messages: [
        first,
        operationResult(2n, 'bash-first'),
        second,
        operationResult(4n, 'read-second'),
        third,
        operationResult(6n, 'write-third'),
      ],
      transientResponses: [],
      runs: [],
    });
    const group = displayFor(items, 'first').toolItems?.[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing mixed conversation group.');

    expect(
      group.operations.map((operation) =>
        operation.kind === 'thinking'
          ? `thinking:${operation.messageId}`
          : `call:${operation.call.toolCallId}`,
      ),
    ).toEqual([
      'thinking:first',
      'call:bash-first',
      'thinking:second',
      'call:read-second',
      'thinking:third',
      'call:write-third',
    ]);
    expect(displayFor(items, 'second').toolItems).toEqual([]);
    expect(displayFor(items, 'third').toolItems).toEqual([]);
    expect(displayFor(items, 'second').mergedThinkingBlockIndexes?.has(0)).toBe(true);
  });

  it('joins consecutive ordinary tool messages without Thinking', () => {
    const first = operationMessage('first', 1n, 'bash');
    const second = operationMessage('second', 3n, 'read');
    const items = projectConversation({
      threadId,
      messages: [first, operationResult(2n, 'bash-first'), second],
      transientResponses: [],
      runs: [],
    });

    const group = displayFor(items, 'first').toolItems?.[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing ordinary conversation group.');
    expect(group.operations.map((operation) => operation.id)).toEqual([
      'bash-first',
      'read-second',
    ]);
    expect(displayFor(items, 'second').toolItems).toEqual([]);
    expect(displayFor(items, 'second').mergedThinkingBlockIndexes?.size).toBe(0);
  });

  it('uses response text as a boundary and starts a new execution segment', () => {
    const first = operationMessage('first', 1n, 'bash');
    const second = operationMessage('second', 2n, 'read', undefined, '正文边界');
    const third = operationMessage('third', 3n, 'write');
    const items = projectConversation({
      threadId,
      messages: [first, second, third],
      transientResponses: [],
      runs: [],
    });

    const firstGroup = displayFor(items, 'first').toolItems?.[0];
    const secondGroup = displayFor(items, 'second').toolItems?.[0];
    if (firstGroup?.kind !== 'ordinary' || secondGroup?.kind !== 'ordinary') {
      throw new Error('Missing text-boundary groups.');
    }
    expect(firstGroup.operations.map((operation) => operation.id)).toEqual(['bash-first']);
    expect(secondGroup.operations.map((operation) => operation.id)).toEqual([
      'read-second',
      'write-third',
    ]);
    expect(displayFor(items, 'second').message.content).toBe('正文边界');
    expect(displayFor(items, 'third').toolItems).toEqual([]);
  });

  it('does not merge a later message before trailing response text', () => {
    const first = operationMessage('first', 1n, 'bash');
    first.content = '工具后的正文';
    first.contentBlocks = [
      create(ContentBlockSchema, {
        type: ContentBlockType.TEXT,
        blockIndex: 0,
        text: '工具后的正文',
      }),
    ];
    const firstCall = first.toolCalls[0];
    if (!firstCall) throw new Error('Missing first call.');
    first.toolCalls[0] = create(ToolCallSchema, { ...firstCall, blockIndex: 0 });
    const second = operationMessage('second', 2n, 'read');
    const items = projectConversation({
      threadId,
      messages: [first, second],
      transientResponses: [],
      runs: [],
    });
    const firstGroup = displayFor(items, 'first').toolItems?.[0];
    const secondGroup = displayFor(items, 'second').toolItems?.[0];

    expect(
      firstGroup?.kind === 'ordinary' && firstGroup.calls.map((call) => call.toolCallId),
    ).toEqual(['bash-first']);
    expect(
      secondGroup?.kind === 'ordinary' && secondGroup.calls.map((call) => call.toolCallId),
    ).toEqual(['read-second']);
  });

  it('merges persisted Thinking-only messages and keeps special cards outside mixed groups', () => {
    const first = operationMessage('first', 1n, 'bash', '思考一');
    const special = operationMessage('special', 3n, 'subagent', '独立思考');
    const third = operationMessage('third', 4n, 'read', '思考三');
    const thinkingOnly = create(MessageSchema, {
      messageId: 'thinking-only',
      threadId,
      agentId: 'thread',
      seq: 5n,
      role: MessageRole.ASSISTANT,
      contentBlocks: [{ type: ContentBlockType.THINKING, blockIndex: 0, text: '仅思考' }],
    });
    const items = projectConversation({
      threadId,
      messages: [first, operationResult(2n, 'bash-first'), special, third, thinkingOnly],
      transientResponses: [],
      runs: [],
    });

    expect(displayFor(items, 'special').toolItems?.map((item) => item.kind)).toEqual([
      'ordinary',
      'subagent',
    ]);
    expect(displayFor(items, 'special').mergedThinkingBlockIndexes).toEqual(new Set([0]));
    const thirdGroup = displayFor(items, 'third').toolItems?.[0];
    if (thirdGroup?.kind !== 'ordinary') throw new Error('Missing following mixed group.');
    expect(
      thirdGroup.operations.map((operation) =>
        operation.kind === 'thinking'
          ? `thinking:${operation.messageId}`
          : `call:${operation.call.toolCallId}`,
      ),
    ).toEqual(['thinking:third', 'call:read-third', 'thinking:thinking-only']);
    expect(displayFor(items, 'thinking-only').toolItems).toEqual([]);
    expect(displayFor(items, 'thinking-only').mergedThinkingBlockIndexes).toEqual(new Set([0]));
  });

  it('uses Recap as a group boundary', () => {
    const first = operationMessage('first', 1n, 'bash', '思考一');
    const second = operationMessage('second', 3n, 'read', '思考二');
    const items = projectConversation({
      threadId,
      messages: [first, operationResult(2n, 'bash-first'), second],
      transientResponses: [],
      runs: [],
      recaps: [
        create(RecapSchema, {
          recapId: 'recap-1',
          threadId,
          agentId: 'thread',
          seq: 1n,
          sourceSeqStart: 1n,
          sourceSeqEnd: 1n,
          sourceMessageSeqs: [1n],
          content: '区间概述',
          validity: RecapValidity.VALID,
        }),
      ],
    });

    expect(items.some((item) => item.kind === 'recap')).toBe(true);
    const firstGroup = displayFor(items, 'first').toolItems?.[0];
    const secondGroup = displayFor(items, 'second').toolItems?.[0];
    if (firstGroup?.kind !== 'ordinary' || secondGroup?.kind !== 'ordinary') {
      throw new Error('Missing boundary groups.');
    }
    expect(firstGroup.operations).toHaveLength(2);
    expect(secondGroup.operations).toHaveLength(2);
  });

  it('merges streaming and persisted Thinking-only messages without a duplicate continuation', () => {
    const first = operationMessage('first', 1n, 'bash', '思考一');
    const streamingThinking = [
      create(ContentBlockSchema, {
        type: ContentBlockType.THINKING,
        blockIndex: 0,
        text: '流式思考二',
      }),
    ];
    const streamingItems = projectConversation({
      threadId,
      messages: [first, operationResult(2n, 'bash-first')],
      transientResponses: [
        {
          messageId: 'second',
          runId: 'run-1',
          agentId: 'thread',
          deltaSeq: 1n,
          contentBlocks: streamingThinking,
        },
      ],
      runs: [],
    });
    const streamingGroup = displayFor(streamingItems, 'first').toolItems?.[0];
    if (streamingGroup?.kind !== 'ordinary') throw new Error('Missing streaming group.');
    expect(
      streamingGroup.operations.map((operation) =>
        operation.kind === 'thinking'
          ? `thinking:${operation.messageId}`
          : `call:${operation.call.toolCallId}`,
      ),
    ).toEqual(['thinking:first', 'call:bash-first', 'thinking:second']);
    expect(streamingGroup.operations.at(-1)).toMatchObject({
      kind: 'thinking',
      messageId: 'second',
      active: true,
      text: '流式思考二',
    });
    expect(displayFor(streamingItems, 'second').toolItems).toEqual([]);
    expect(displayFor(streamingItems, 'second').mergedThinkingBlockIndexes).toEqual(new Set([0]));

    const second = create(MessageSchema, {
      ...first,
      messageId: 'second',
      seq: 3n,
      content: '',
      contentBlocks: streamingThinking,
      toolCalls: [],
    });
    const restoredItems = projectConversation({
      threadId,
      messages: [first, operationResult(2n, 'bash-first'), second],
      transientResponses: [],
      runs: [],
    });
    const restoredGroup = displayFor(restoredItems, 'first').toolItems?.[0];
    if (restoredGroup?.kind !== 'ordinary') throw new Error('Missing restored group.');
    expect(
      restoredGroup.operations.map((operation) =>
        operation.kind === 'thinking'
          ? `thinking:${operation.messageId}`
          : `call:${operation.call.toolCallId}`,
      ),
    ).toEqual(['thinking:first', 'call:bash-first', 'thinking:second']);
    expect(restoredGroup.operations.at(-1)).toMatchObject({
      kind: 'thinking',
      messageId: 'second',
      active: false,
    });
    expect(displayFor(restoredItems, 'first').mergedThinkingBlockIndexes).toEqual(new Set([0]));
    expect(displayFor(restoredItems, 'second').toolItems).toEqual([]);
    expect(displayFor(restoredItems, 'second').mergedThinkingBlockIndexes).toEqual(new Set([0]));
  });
});

describe('queued direct user input projection', () => {
  function queuedInput(inputId: string, text: string) {
    return create(InputSchema, {
      inputId,
      threadId,
      text,
      mode: InputMode.FOLLOW_UP,
      status: InputStatus.QUEUED,
      source: MessageSource.USER,
      position: 1n,
      version: 1n,
      createdAt: { seconds: 1_700_000_000n, nanos: 0 },
    });
  }

  it('shows a queued message immediately with a pending indicator in both display modes', () => {
    const input = queuedInput('input-1', '立即显示');
    const items = projectConversation({
      threadId,
      messages: [],
      transientResponses: [],
      runs: [run('run-1', RunStatus.QUEUED)],
      inputs: [input],
    });
    expect(items.map((item) => item.kind)).toEqual(['message', 'pending-agent']);
    const first = items[0];
    if (first?.kind !== 'message') throw new Error('Queued user message is missing.');
    expect(first.value.message).toMatchObject({
      messageId: 'queued:input-1',
      role: MessageRole.USER,
      source: MessageSource.USER,
      sourceInputId: 'input-1',
      content: '立即显示',
    });
    expect(projectConversationDisplay(items, [], 'compact').map((item) => item.kind)).toEqual([
      'message',
      'pending-agent',
    ]);
    expect(projectConversationDisplay(items, [], 'full').map((item) => item.kind)).toEqual([
      'message',
      'pending-agent',
    ]);
  });

  it('removes the pending indicator after the input is consumed or cancelled', () => {
    const input = queuedInput('input-1', '立即显示');
    const consumedMessage = message('立即显示', 1n);
    Object.assign(consumedMessage, { sourceInputId: 'input-1' });
    const consumed = projectConversation({
      threadId,
      messages: [consumedMessage],
      transientResponses: [],
      runs: [run('run-1', RunStatus.RUNNING)],
      inputs: [input],
    });
    expect(consumed.map((item) => item.kind)).toEqual(['message', 'pending-agent']);
    const consumedPending = consumed.at(-1);
    if (consumedPending?.kind !== 'pending-agent' || !('runId' in consumedPending.value)) {
      throw new Error('Run pending indicator is missing.');
    }
    expect(consumedPending.value.runId).toBe('run-1');
    expect(consumed[0]?.kind === 'message' && consumed[0].value.message.messageId).not.toBe(
      'queued:input-1',
    );

    const cancelled = projectConversation({
      threadId,
      messages: [],
      transientResponses: [],
      runs: [run('run-1', RunStatus.CANCELLED)],
      inputs: [{ ...input, status: InputStatus.CANCELLED }],
    });
    expect(cancelled.map((item) => item.kind)).toEqual(['run-outcome']);
  });
});

describe('reminder-prefixed assistant messages', () => {
  const reminder =
    '<system-reminder>\n<msg seq="9" time="2026-11-14T01:35:00+08:00"/>\n</system-reminder>\n\n';

  function reminderAssistant(messageId: string, seq: bigint, callId: string): Message {
    return create(MessageSchema, {
      messageId,
      threadId,
      agentId: 'thread',
      seq,
      role: MessageRole.ASSISTANT,
      content: reminder,
      contentBlocks: [
        create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 0, text: reminder }),
      ],
      toolCalls: [
        create(ToolCallSchema, { toolCallId: callId, toolName: 'bash', argumentsJson: '{}' }),
      ],
    });
  }

  it('merges tool groups across reminder-only messages and hides the empty text', () => {
    const items = projectConversation({
      threadId,
      messages: [
        message('开始', 1n),
        reminderAssistant('r1', 2n, 'c1'),
        reminderAssistant('r2', 4n, 'c2'),
        reminderAssistant('r3', 6n, 'c3'),
      ],
      transientResponses: [],
      runs: [run('run-1', RunStatus.COMPLETED)],
    });
    const assistants = items.filter(
      (item) => item.kind === 'message' && item.value.message.role === MessageRole.ASSISTANT,
    );
    const first = assistants[0];
    if (first?.kind !== 'message') throw new Error('missing first assistant');
    expect(first.value.toolItems?.map((group) => group.kind)).toEqual(['ordinary']);
    const merged = first.value.toolItems?.[0];
    expect(merged?.kind === 'ordinary' && merged.calls.map((call) => call.toolCallId)).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
    expect(first.value.message.content.trim()).toBe('');
    for (const follower of assistants.slice(1)) {
      if (follower.kind !== 'message') continue;
      expect(follower.value.toolItems).toEqual([]);
      expect(follower.value.message.content.trim()).toBe('');
    }
  });

  it('strips the reminder but keeps the visible text and its group open for merging', () => {
    const withText = create(MessageSchema, {
      messageId: 'r-text',
      threadId,
      agentId: 'thread',
      seq: 2n,
      role: MessageRole.ASSISTANT,
      content: `${reminder}实际分析`,
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.TEXT,
          blockIndex: 0,
          text: `${reminder}实际分析`,
        }),
      ],
      toolCalls: [
        create(ToolCallSchema, { toolCallId: 'c1', toolName: 'bash', argumentsJson: '{}' }),
      ],
    });
    const items = projectConversation({
      threadId,
      messages: [message('开始', 1n), withText, reminderAssistant('r2', 4n, 'c2')],
      transientResponses: [],
      runs: [run('run-1', RunStatus.COMPLETED)],
    });
    const assistants = items.filter(
      (item) => item.kind === 'message' && item.value.message.role === MessageRole.ASSISTANT,
    );
    const first = assistants[0];
    if (first?.kind !== 'message') throw new Error('missing first assistant');
    expect(first.value.message.content).toBe('实际分析');
    const merged = first.value.toolItems?.[0];
    expect(merged?.kind === 'ordinary' && merged.calls.map((call) => call.toolCallId)).toEqual([
      'c1',
      'c2',
    ]);
    const second = assistants[1];
    if (second?.kind !== 'message') throw new Error('missing second assistant');
    expect(second.value.toolItems).toEqual([]);
  });
});

describe('active run pending indicator', () => {
  function sentToUser(runId: string, seq: bigint): Message {
    return create(MessageSchema, {
      messageId: `sent-${seq}`,
      threadId,
      agentId: 'thread',
      seq,
      role: MessageRole.TOOL,
      toolName: 'send_to_user',
      toolCallId: `call-${seq}`,
      toolStatus: ToolResultStatus.SUCCESS,
      runId,
      content: JSON.stringify({ status: 'sent', content: '回复', end_turn: true }),
    });
  }

  it('shows the typing indicator while the run has not replied via send_to_user', () => {
    const items = projectConversation({
      threadId,
      messages: [message('问题', 1n)],
      transientResponses: [],
      runs: [run('run-1', RunStatus.RUNNING)],
    });
    expect(items.map((item) => item.kind)).toEqual(['message', 'pending-agent']);
    const pending = items.at(-1);
    if (pending?.kind !== 'pending-agent' || !('runId' in pending.value)) {
      throw new Error('Run pending indicator is missing.');
    }
    expect(pending.value.runId).toBe('run-1');
  });

  it('hides the typing indicator once send_to_user replied or the run ended', () => {
    const replied = projectConversation({
      threadId,
      messages: [message('问题', 1n), sentToUser('run-1', 2n)],
      transientResponses: [],
      runs: [run('run-1', RunStatus.RUNNING)],
    });
    expect(replied.map((item) => item.kind)).toEqual(['message', 'message']);

    const finished = projectConversation({
      threadId,
      messages: [message('问题', 1n)],
      transientResponses: [],
      runs: [run('run-1', RunStatus.COMPLETED)],
    });
    expect(finished.map((item) => item.kind)).toEqual(['message']);
  });
});

describe('streaming reminder suppression', () => {
  const threadId = 'thread-stream';
  function streamingTransient(text: string) {
    return {
      messageId: 'stream-1',
      runId: 'run-1',
      agentId: 'thread',
      deltaSeq: 3n,
      contentBlocks: [
        create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 0, text }),
      ],
    };
  }
  function streamItems(text: string) {
    return projectConversation({
      threadId,
      messages: [],
      transientResponses: [streamingTransient(text)],
      runs: [run('run-1', RunStatus.RUNNING)],
    });
  }

  it('hides an unclosed leading reminder while streaming', () => {
    const items = streamItems('<system-reminder>\n<msg seq="9"');
    expect(items.filter((item) => item.kind === 'message')).toEqual([]);
  });

  it('shows only the answer once the leading reminder closes', () => {
    const items = streamItems(
      '<system-reminder>\n<msg seq="9"/>\n</system-reminder>\n\n正式回复内容',
    );
    const assistants = items.filter(
      (item) => item.kind === 'message' && item.value.message.role === MessageRole.ASSISTANT,
    );
    expect(assistants).toHaveLength(1);
    const first = assistants[0];
    if (first?.kind !== 'message') throw new Error('missing streamed assistant');
    expect(first.value.message.content).toBe('正式回复内容');
    expect(first.value.streaming).toBe(true);
  });
});
