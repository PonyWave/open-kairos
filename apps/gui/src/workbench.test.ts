import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  create,
  ErrorCode,
  ErrorDetailSchema,
  InputMode,
  MessageService,
  QueueService,
  RunService,
  RunStatus,
  ThreadSchema,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore } from './actions.js';
import { createKairosClients } from './client.js';
import { ThreadDirectory } from './workbench.js';

const main = create(ThreadSchema, {
  threadId: 'main-1',
  title: '唯一主对话',
  seq: 1n,
  threadType: ThreadType.MAIN,
});
const firstTask = create(ThreadSchema, {
  threadId: 'task-1',
  title: '列表首条任务',
  seq: 2n,
  threadType: ThreadType.TASK,
});
describe('ThreadDirectory main entry', () => {
  it('selects the authenticated main id without creating or fetching a Thread', () => {
    const directory = new ThreadDirectory({
      mainThreadId: main.threadId,
    });

    directory.showMain();
    expect(directory.state.selectedThreadId).toBe(main.threadId);
    expect(directory.state.mainThreadId).toBe(main.threadId);
    expect(directory.state.mainThread).toBeNull();
  });

  it('keeps main and task selection synchronous and independent', () => {
    const directory = new ThreadDirectory({
      mainThreadId: main.threadId,
    });

    directory.showMain();
    directory.openThread(firstTask.threadId);
    expect(directory.state.selectedThreadId).toBe(firstTask.threadId);
    directory.showMain();
    expect(directory.state.selectedThreadId).toBe(main.threadId);
    expect(directory.state.page).toBe('thread');
  });

  it('sends ordinary main conversation without GetOrCreateMain or environment setup', async () => {
    let createMainCalls = 0;
    const sent: string[] = [];
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getOrCreateMain() {
          createMainCalls += 1;
          throw new Error('主入口不得创建 Thread');
        },
      });
      router.service(MessageService, {
        sendMessage(request) {
          sent.push(request.threadId);
          return {
            clientActionId: request.clientActionId,
            inputId: 'input-main-1',
            threadId: request.threadId,
          };
        },
      });
    });
    const clients = createKairosClients({ transport });
    const directory = new ThreadDirectory({ mainThreadId: main.threadId });
    const actions = new ActionExecutor(new ClientActionStore(), createActionHandlers(clients));

    directory.showMain();
    await actions.execute('send:main-first', 'sendMessage', {
      threadId: directory.state.selectedThreadId,
      text: '未配置环境时的普通对话',
      mode: InputMode.FOLLOW_UP,
    });

    expect(sent).toEqual([main.threadId]);
    expect(createMainCalls).toBe(0);
    expect(actions.state.failures).toEqual([]);
  });
});

describe('task Thread direct interaction', () => {
  it('sends steer and follow_up to the open task without cancelling it on page close', async () => {
    const sent: { threadId: string; mode: InputMode; clientActionId: string }[] = [];
    let cancelCalls = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        listThreads: () => ({ threads: [main, firstTask], hasMore: false }),
      });
      router.service(MessageService, {
        sendMessage(request) {
          sent.push({
            threadId: request.threadId,
            mode: request.mode,
            clientActionId: request.clientActionId,
          });
          return {
            clientActionId: request.clientActionId,
            inputId: `input-${sent.length}`,
            threadId: request.threadId,
          };
        },
      });
      router.service(RunService, {
        cancelRun(request) {
          cancelCalls += 1;
          return {
            clientActionId: request.clientActionId,
            runId: request.runId,
            status: RunStatus.CANCEL_REQUESTED,
          };
        },
      });
    });
    const clients = createKairosClients({ transport });
    const directory = new ThreadDirectory({ mainThreadId: main.threadId });
    const actions = new ActionExecutor(new ClientActionStore(), createActionHandlers(clients));

    directory.openDirectory();
    directory.openThread(firstTask.threadId);
    await actions.execute('send-task-steer', 'sendMessage', {
      threadId: firstTask.threadId,
      text: '中途补充',
      mode: InputMode.STEER,
    });
    await actions.execute('send-task-follow-up', 'sendMessage', {
      threadId: firstTask.threadId,
      text: '后续输入',
      mode: InputMode.FOLLOW_UP,
    });
    directory.openDirectory();

    expect(sent.map(({ threadId, mode }) => ({ threadId, mode }))).toEqual([
      { threadId: firstTask.threadId, mode: InputMode.STEER },
      { threadId: firstTask.threadId, mode: InputMode.FOLLOW_UP },
    ]);
    expect(new Set(sent.map((item) => item.clientActionId)).size).toBe(2);
    expect(cancelCalls).toBe(0);
    expect(actions.state.failures).toHaveLength(0);
  });

  it('surfaces explicit Server errors for generic edits and removal of linked inputs', async () => {
    const reject = (operation: string) =>
      new ConnectError('rejected', Code.FailedPrecondition, undefined, [
        {
          desc: ErrorDetailSchema,
          value: {
            code: ErrorCode.FAILED_PRECONDITION,
            message: `Interaction-linked input rejects ${operation}.`,
            retryable: false,
          },
        },
      ]);
    const transport = createRouterTransport((router) => {
      router.service(QueueService, {
        editInput() {
          throw reject('edit');
        },
        removeInput() {
          throw reject('remove');
        },
      });
    });
    const actions = new ActionExecutor(
      new ClientActionStore(),
      createActionHandlers(createKairosClients({ transport })),
    );

    await actions.execute('edit-linked-input', 'editInput', {
      threadId: firstTask.threadId,
      inputId: 'input-linked',
      text: '通用编辑',
      expectedVersion: '1',
    });
    await actions.execute('remove-linked-input', 'removeInput', {
      threadId: firstTask.threadId,
      inputId: 'input-linked',
      expectedVersion: '1',
    });

    expect(actions.state.failures.map((failure) => failure.message)).toEqual([
      '当前状态不允许该操作。 Interaction-linked input rejects edit.',
      '当前状态不允许该操作。 Interaction-linked input rejects remove.',
    ]);
    expect(actions.state.failures.every((failure) => failure.outcome === 'not-executed')).toBe(
      true,
    );
  });
});

describe('approved workbench entry differences', () => {
  it('opens sidebar topics full-screen without replacing or refetching the mounted main Thread', () => {
    const directory = new ThreadDirectory({
      mainThreadId: main.threadId,
    });
    directory.upsertThread(main);
    directory.showMain();

    directory.openThread(firstTask.threadId);
    expect(directory.state.selectedThreadId).toBe(firstTask.threadId);
    expect(directory.state.mainThread?.threadId).toBe(main.threadId);

    directory.showMain();
    expect(directory.state.selectedThreadId).toBe(main.threadId);

    directory.openDirectory();
    expect(directory.state.mainThread?.threadId).toBe(main.threadId);
    directory.showMain();
  });
});
