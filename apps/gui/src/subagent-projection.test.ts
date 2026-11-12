import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  DelegationReferenceSchema,
  MessageRole,
  MessageSchema,
  MessageSource,
  RunSchema,
  RunStatus,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { projectConversation, selectPaneMessages } from './response-projection.js';

const rootRun = create(RunSchema, {
  runId: 'root-run',
  threadId: 'main',
  agentId: 'thread',
  status: RunStatus.WAITING,
});
const childRun = create(RunSchema, {
  runId: 'child-run',
  threadId: 'main',
  agentId: 'child',
  parentRunId: 'root-run',
  status: RunStatus.RUNNING,
});
const parent = create(MessageSchema, {
  messageId: 'root',
  threadId: 'main',
  agentId: 'thread',
  runId: 'root-run',
  seq: 1n,
  role: MessageRole.ASSISTANT,
  content: 'ROOT_ONLY',
});
const prompt = create(MessageSchema, {
  messageId: 'child-prompt',
  threadId: 'main',
  agentId: 'child',
  runId: 'child-run',
  seq: 1n,
  role: MessageRole.USER,
  content: 'CHILD_TASK',
});
const reply = create(MessageSchema, {
  messageId: 'child-reply',
  threadId: 'main',
  agentId: 'child',
  runId: 'child-run',
  seq: 2n,
  role: MessageRole.ASSISTANT,
  content: 'CHILD_REPLY',
});
const live = {
  messageId: 'child-stream',
  agentId: 'child',
  runId: 'child-run',
  deltaSeq: 1n,
  contentBlocks: [
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 0,
      text: 'CHILD_THINKING',
    }),
  ],
};

describe('Agent view isolation', () => {
  it('keeps child prompts, replies, live Thinking and failures out of the root projection', () => {
    const items = projectConversation({
      threadId: 'main',
      messages: [parent, prompt, reply],
      runs: [rootRun, { ...childRun, status: RunStatus.FAILED }],
      transientResponses: [live],
    });
    expect(items.map((item) => item.key)).toEqual(['root']);
  });
  it('projects only the selected child stream even when sequence numbers overlap', () => {
    const items = projectConversation({
      threadId: 'main',
      agentId: 'child',
      messages: [parent, prompt, reply],
      runs: [rootRun, childRun],
      transientResponses: [live],
    });
    expect(items.map((item) => item.key)).toEqual(['child-prompt', 'child-reply', 'child-stream']);
    const item = items.at(-1);
    expect(item?.kind === 'message' && item.value.message.agentId).toBe('child');
  });
  it('keeps streams without message or Run ownership out of the root view', () => {
    const unattributed = { ...live, agentId: undefined };
    const items = projectConversation({
      threadId: 'main',
      messages: [parent, prompt],
      runs: [rootRun, { ...childRun, agentId: undefined }],
      transientResponses: [unattributed],
    });
    expect(items.map((item) => item.key)).toEqual(['root']);
    const unknown = projectConversation({
      threadId: 'main',
      messages: [parent],
      runs: [rootRun, { ...childRun, agentId: undefined }],
      transientResponses: [unattributed],
    });
    expect(unknown.map((item) => item.key)).toEqual(['root']);
  });
  it('removes only the matching Thread source prompt from a sidebar', () => {
    const call = create(DelegationReferenceSchema, {
      sourceThreadId: 'main',
      sourceAgentId: 'thread',
      sourceToolCallId: 'call-a',
    });
    const first = create(MessageSchema, {
      ...prompt,
      threadId: 'topic',
      agentId: 'thread',
      source: MessageSource.THREAD_CALL,
      delegation: call,
    });
    const other = create(MessageSchema, {
      ...first,
      messageId: 'other-prompt',
      delegation: create(DelegationReferenceSchema, { ...call, sourceToolCallId: 'call-b' }),
    });
    expect(
      selectPaneMessages([first, other], 'thread', { sourceCall: call }).map(
        (item) => item.messageId,
      ),
    ).toEqual(['other-prompt']);
    expect(selectPaneMessages([first, other], 'thread').map((item) => item.messageId)).toEqual([
      'child-prompt',
      'other-prompt',
    ]);
  });
  it('shows the selected child task once above the stream', () => {
    expect(
      selectPaneMessages([parent, prompt, reply], 'child', {
        task: 'CHILD_TASK',
        runId: 'child-run',
      }).map((item) => item.messageId),
    ).toEqual(['child-reply']);
  });
});
