import { createRouterTransport } from '@connectrpc/connect';
import {
  BashOperationStatus,
  CompactContextStatus,
  ContextService,
  InputMode,
  InputStatus,
  MessageRole,
  MessageService,
  QueueService,
  RecapValidity,
  RunService,
  RunStatus,
  ThreadService,
  WorkspaceService,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ClientActionStore } from './actions.js';
import { createKairosClients } from './client.js';

const hugeSeq = 9_007_199_254_740_993n;

function createUnaryHarness() {
  const calls: { method: string; clientActionId: string }[] = [];
  const thread = { threadId: 'thread-1', title: '会话', seq: hugeSeq };
  const message = {
    messageId: 'message-1',
    threadId: 'thread-1',
    agentId: 'agent-1',
    seq: hugeSeq,
    role: MessageRole.USER,
    content: '原始消息',
  };
  const input = {
    inputId: 'input-1',
    threadId: 'thread-1',
    text: '排队输入',
    mode: InputMode.FOLLOW_UP,
    status: InputStatus.QUEUED,
    position: hugeSeq,
    version: hugeSeq,
  };
  const run = {
    runId: 'run-1',
    threadId: 'thread-1',
    status: RunStatus.RUNNING,
    usage: { inputTokens: hugeSeq, outputTokens: hugeSeq + 1n },
  };
  const device = {
    deviceId: 'device-1',
    deviceName: '本机',
    bashEnabled: true,
    accountDescription: '当前账号',
  };
  function record(method: string, clientActionId: string): void {
    calls.push({ method, clientActionId });
  }
  const transport = createRouterTransport((router) => {
    router.service(ThreadService, {
      createThread(request) {
        record('createThread', request.clientActionId);
        return { clientActionId: request.clientActionId, thread };
      },
      getThread() {
        return {
          snapshot: {
            thread,
            messages: [message],
            inputs: [input],
            runs: [run],
            devices: [device],
            queueVersion: hugeSeq,
          },
          throughSeq: hugeSeq,
        };
      },
      listThreads() {
        return { threads: [thread], nextSeq: hugeSeq + 1n, hasMore: true };
      },
      renameThread(request) {
        record('renameThread', request.clientActionId);
        return {
          clientActionId: request.clientActionId,
          thread: { ...thread, title: request.title },
        };
      },
    });
    router.service(MessageService, {
      sendMessage(request) {
        record('sendMessage', request.clientActionId);
        return {
          clientActionId: request.clientActionId,
          inputId: input.inputId,
          threadId: request.threadId,
        };
      },
      reviseMessage(request) {
        record('reviseMessage', request.clientActionId);
        return {
          clientActionId: request.clientActionId,
          messageId: request.messageId,
          revisionId: 'revision-1',
        };
      },
    });
    router.service(QueueService, {
      editInput(request) {
        record('editInput', request.clientActionId);
        expect(request.expectedVersion).toBe(hugeSeq);
        return {
          clientActionId: request.clientActionId,
          inputId: input.inputId,
          version: hugeSeq + 1n,
        };
      },
      removeInput(request) {
        record('removeInput', request.clientActionId);
        expect(request.expectedVersion).toBe(hugeSeq);
        return {
          clientActionId: request.clientActionId,
          inputId: input.inputId,
          queueVersion: hugeSeq + 1n,
        };
      },
      reorderInputs(request) {
        record('reorderInputs', request.clientActionId);
        expect(request.expectedVersion).toBe(hugeSeq);
        return {
          clientActionId: request.clientActionId,
          inputs: [input],
          queueVersion: hugeSeq + 1n,
        };
      },
    });
    router.service(RunService, {
      cancelRun(request) {
        record('cancelRun', request.clientActionId);
        return {
          clientActionId: request.clientActionId,
          runId: request.runId,
          status: RunStatus.CANCEL_REQUESTED,
        };
      },
      continueRun(request) {
        record('continueRun', request.clientActionId);
        return {
          clientActionId: request.clientActionId,
          runId: request.runId,
          status: RunStatus.QUEUED,
        };
      },
      rerun(request) {
        record('rerun', request.clientActionId);
        return {
          clientActionId: request.clientActionId,
          runId: 'run-2',
          status: RunStatus.QUEUED,
        };
      },
    });
    router.service(ContextService, {
      readContext() {
        return { messages: [message], nextSeq: hugeSeq + 1n, hasMore: true };
      },
      readRecaps() {
        return {
          recaps: [
            {
              recapId: 'recap-1',
              threadId: thread.threadId,
              agentId: 'agent-1',
              seq: hugeSeq,
              sourceSeqStart: hugeSeq,
              sourceSeqEnd: hugeSeq + 2n,
              sourceMessageSeqs: [hugeSeq, hugeSeq + 2n],
              content: '内容',
              validity: RecapValidity.VALID,
            },
          ],
          nextSeq: hugeSeq + 1n,
          hasMore: false,
        };
      },
      compactContext(request) {
        record('compactContext', request.clientActionId);
        return {
          operationId: 'compact-operation-1',
          status: CompactContextStatus.CHANGED,
          readThroughSeq: hugeSeq,
          recapIds: ['recap-1'],
        };
      },
    });
    router.service(WorkspaceService, {
      reloadResources(request) {
        record('reloadResources', request.clientActionId);
        return {
          snapshotId: 'snapshot-1',
          changed: true,
          resources: ['AGENTS.md'],
          added: ['AGENTS.md'],
          updated: [],
          removed: [],
        };
      },
    });
  });
  return {
    clients: createKairosClients({ transport }),
    calls,
    thread,
    message,
    input,
    run,
    device,
  };
}

describe('generated Connect clients', () => {
  it('executes every GUI command and query with lossless uint64 fields', async () => {
    const { clients, calls, thread, message, input, run } = createUnaryHarness();
    const actions = new ClientActionStore();
    const kinds = {
      create: 'createThread',
      rename: 'renameThread',
      send: 'sendMessage',
      revise: 'reviseMessage',
      edit: 'editInput',
      remove: 'removeInput',
      reorder: 'reorderInputs',
      cancel: 'cancelRun',
      continue: 'continueRun',
      rerun: 'rerun',
      reload: 'reloadResources',
      compact: 'compactContext',
    } as const;
    const id = (key: keyof typeof kinds) => actions.begin(key, kinds[key], { key }).id;

    const created = await clients.thread.createThread({
      clientActionId: id('create'),
      title: thread.title,
    });
    expect(created.thread?.seq).toBe(hugeSeq);
    await clients.thread.renameThread({
      clientActionId: id('rename'),
      threadId: thread.threadId,
      title: '新标题',
    });
    const sendId = id('send');
    const sent = await clients.messages.sendMessage({
      clientActionId: sendId,
      threadId: thread.threadId,
      text: '执行',
      mode: InputMode.STEER,
    });
    expect(sent.inputId).toBe(input.inputId);
    await clients.messages.sendMessage({
      clientActionId: id('send'),
      threadId: thread.threadId,
      text: '执行',
      mode: InputMode.STEER,
    });
    await clients.messages.reviseMessage({
      clientActionId: id('revise'),
      threadId: thread.threadId,
      messageId: message.messageId,
      text: '修订',
      expectedRevisionId: 'revision-0',
    });
    expect(
      (
        await clients.queue.editInput({
          clientActionId: id('edit'),
          threadId: thread.threadId,
          inputId: input.inputId,
          text: '修改',
          expectedVersion: hugeSeq,
        })
      ).version,
    ).toBe(hugeSeq + 1n);
    await clients.queue.removeInput({
      clientActionId: id('remove'),
      threadId: thread.threadId,
      inputId: input.inputId,
      expectedVersion: hugeSeq,
    });
    await clients.queue.reorderInputs({
      clientActionId: id('reorder'),
      threadId: thread.threadId,
      inputIds: [input.inputId],
      expectedVersion: hugeSeq,
    });
    expect(
      (
        await clients.runs.cancelRun({
          clientActionId: id('cancel'),
          threadId: thread.threadId,
          runId: run.runId,
          reason: '停止',
        })
      ).status,
    ).toBe(RunStatus.CANCEL_REQUESTED);
    await clients.runs.continueRun({
      clientActionId: id('continue'),
      threadId: thread.threadId,
      runId: run.runId,
    });
    await clients.runs.rerun({
      clientActionId: id('rerun'),
      threadId: thread.threadId,
      messageId: message.messageId,
    });
    const reloaded = await clients.workspace.reloadResources({
      clientActionId: id('reload'),
      threadId: thread.threadId,
    });
    expect(reloaded.snapshotId).toBe('snapshot-1');
    const compacted = await clients.context.compactContext({
      clientActionId: id('compact'),
      threadId: thread.threadId,
    });
    expect(compacted.readThroughSeq).toBe(hugeSeq);

    const snapshot = await clients.thread.getThread({ threadId: thread.threadId });
    expect(snapshot.throughSeq).toBe(hugeSeq);
    expect(snapshot.snapshot?.queueVersion).toBe(hugeSeq);
    expect(snapshot.snapshot?.runs[0]?.usage?.inputTokens).toBe(hugeSeq);
    expect((await clients.thread.listThreads({ afterSeq: 0n, limit: 50 })).nextSeq).toBe(
      hugeSeq + 1n,
    );
    const context = await clients.context.readContext({
      threadId: thread.threadId,
      agentId: '',
      afterSeq: 0n,
      limit: 100,
    });
    expect(context.messages[0]?.seq).toBe(hugeSeq);
    const recaps = await clients.context.readRecaps({
      threadId: thread.threadId,
      agentId: '',
      afterSeq: 0n,
      limit: 50,
    });
    expect(recaps.recaps[0]?.sourceMessageSeqs).toEqual([hugeSeq, hugeSeq + 2n]);

    expect(calls.filter((call) => call.method === 'sendMessage')).toEqual([
      { method: 'sendMessage', clientActionId: sendId },
      { method: 'sendMessage', clientActionId: sendId },
    ]);
    expect(calls.every((call) => call.clientActionId.length > 0)).toBe(true);
    expect(new Set(calls.map((call) => call.method))).toEqual(
      new Set([
        'createThread',
        'renameThread',
        'sendMessage',
        'reviseMessage',
        'editInput',
        'removeInput',
        'reorderInputs',
        'cancelRun',
        'continueRun',
        'rerun',
        'reloadResources',
        'compactContext',
      ]),
    );
  });

  it('exposes the existing Bash status without converting an unknown result to success', () => {
    expect(BashOperationStatus.UNKNOWN).not.toBe(BashOperationStatus.COMPLETED);
  });
});
