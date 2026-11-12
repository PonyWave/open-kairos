/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import {
  AutomationFireSchema,
  AutomationFireStatus,
  AutomationScheduleKind,
  AutomationSchema,
  AutomationTargetKind,
  AutomationTrigger,
  create,
  ErrorCode,
  MessageRole,
  MessageSchema,
  MessageSource,
  ThreadSnapshotSchema,
} from '@kairos/contracts';
import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { type ActionKind, ClientActionStore } from './actions.js';
import { AutomationEditor, AutomationFireHistory, AutomationListView } from './automation-page.js';
import { createKairosClients, type KairosClients } from './client.js';
import { ConversationPane } from './conversation-pane.js';
import { FailureNotice } from './failure-notice.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import type { ActionExecutorView } from './use-action-executor.js';
import * as sync from './use-thread-sync.js';

const noop = () => {};
afterEach(() => vi.restoreAllMocks());

const automation = create(AutomationSchema, {
  seq: 1n,
  scheduleId: 'schedule-1',
  name: '每日摘要',
  prompt: '总结当天工作',
  schedule: {
    kind: AutomationScheduleKind.CRON,
    cronExpression: '0 9 * * *',
    timeZone: 'Asia/Shanghai',
  },
  target: { kind: AutomationTargetKind.NEW_AUTOMATION_ONLY },
  enabled: true,
  version: 1n,
  nextFireAt: { seconds: 1_794_274_200n, nanos: 0 },
});
const fire = create(AutomationFireSchema, {
  seq: 1n,
  fireId: 'fire-1',
  scheduleId: 'schedule-1',
  trigger: AutomationTrigger.RUN_NOW,
  scheduleVersion: 1n,
  scheduledAt: { seconds: 1_794_274_200n, nanos: 0 },
  actualAt: { seconds: 1_794_274_260n, nanos: 0 },
  finishedAt: { seconds: 1_794_274_320n, nanos: 0 },
  prompt: '总结当天工作',
  targetKind: AutomationTargetKind.NEW_AUTOMATION_ONLY,
  targetThreadId: 'hidden-1',
  targetThreadTitle: '每日工作摘要',
  status: AutomationFireStatus.FAILED,
  error: { code: ErrorCode.INTERNAL, message: '模型服务失败', terminal: true },
});

function actionView(clients: KairosClients): ActionExecutorView {
  const executor = new ActionExecutor(new ClientActionStore(), createActionHandlers(clients));
  return {
    execute: <T>(key: string, kind: ActionKind, payload: unknown) =>
      executor.execute<T>(key, kind, payload),
    retry: <T>(key: string) => executor.retry<T>(key),
    dismiss: (key) => executor.dismiss(key),
    busy: false,
    failures: [],
  };
}

describe('Automation management components', () => {
  it('renders persisted definitions and every fire detail with the hidden-history entry', () => {
    const list = renderToStaticMarkup(
      createElement(AutomationListView, {
        state: {
          automations: [automation],
          nextSeq: null,
          hasMore: false,
          loading: false,
          error: null,
        },
        busy: false,
        pendingFailures: [],
        onSelect: () => {},
        onRun: () => {},
        onReload: () => {},
        onLoadMore: () => {},
      }),
    );
    expect(list).toContain('每日摘要');
    expect(list).toContain('每天 09:00');
    expect(list).not.toContain('0 9 * * *');
    expect(list).toContain('Asia/Shanghai');
    expect(list).toContain('每次新建定时专属话题');
    expect(list).toContain('立即执行');

    const onReload = vi.fn();
    const onLoadMore = vi.fn();
    const failed = AutomationListView({
      state: {
        automations: [automation],
        nextSeq: 1n,
        hasMore: true,
        loading: false,
        error: '刷新失败',
      },
      busy: false,
      pendingFailures: [],
      onSelect: () => {},
      onRun: () => {},
      onReload,
      onLoadMore,
    });
    const notice = Children.toArray(failed.props.children).find(
      (child) => isValidElement(child) && child.type === FailureNotice,
    );
    if (!notice || !isValidElement<{ onRetry: () => void }>(notice)) {
      throw new Error('缺少列表错误提示。');
    }
    notice.props.onRetry();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onLoadMore).not.toHaveBeenCalled();

    const history = renderToStaticMarkup(
      createElement(AutomationFireHistory, {
        state: {
          scheduleId: 'schedule-1',
          fires: [fire],
          nextSeq: null,
          hasMore: false,
          loading: false,
          error: null,
        },
        busy: false,
        onOpenThread: () => {},
        onReload: () => {},
        onLoadMore: () => {},
      }),
    );
    expect(history).toContain('立即执行');
    expect(history).toContain('计划时间');
    expect(history).toContain('结束时间');
    expect(history).toContain('失败');
    expect(history).toContain('模型服务失败');
    expect(history).toContain('查看对话');
    expect(history).toContain('新话题');
    expect(history).toContain('每日工作摘要');
    for (const internal of [
      '查看 prompt 快照',
      '查看定时专属历史',
      '目标',
      'hidden-1',
      'fire-1',
      '总结当天工作',
      '按接受顺序',
    ]) {
      expect(history).not.toContain(internal);
    }
  });

  it('uses the shared dropdowns and repeat/time controls to edit persisted definitions', () => {
    const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
    const html = renderToStaticMarkup(
      createElement(AutomationEditor, {
        clients,
        actions: actionView(clients),
        automation,
        session: 'edit-session',
        onClose: () => {},
        onSaved: () => {},
      }),
    );
    expect(html).toContain('修改定时任务');
    expect(html).toContain('每日摘要');
    expect(html).toContain('总结当天工作');
    expect(html).toContain('每次新建定时专属话题');
    expect(html).toContain('保存后启用定时规则');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('cron');
    expect(html).toContain('aria-label="重复"');
    expect(html).toContain('type="time"');
    expect(html).toContain('value="09:00"');
    expect(html).toContain('aria-label="时区"');
    expect(html).toContain('中国标准时间');
    expect(html).toContain('aria-label="执行目标"');
  });

  it('uses full-width read-only history with authorized sync and no ordinary controls', () => {
    const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
    const threadSyncManager = new ThreadSyncManager(clients);
    const useThreadSync = vi.spyOn(sync, 'useThreadSync').mockReturnValue({
      state: {
        snapshot: create(ThreadSnapshotSchema, {
          thread: {
            threadId: 'hidden-1',
            title: '定时执行历史',
            automationOnly: true,
          },
          messages: [
            create(MessageSchema, {
              messageId: 'message-1',
              threadId: 'hidden-1',
              agentId: 'thread',
              role: MessageRole.USER,
              source: MessageSource.AUTOMATION,
              content: '真实定时 prompt',
            }),
          ],
        }),
        throughSeq: 0n,
        status: 'live',
        error: null,
        transientResponses: [],
        bashOperations: [],
        hardCuts: [],
        invalidatedRecaps: {},
      },
      reload: async () => {},
    });
    const html = renderToStaticMarkup(
      createElement(ConversationPane, {
        clients,
        threadSyncManager,
        variant: 'automation',
        automationScheduleId: 'schedule-1',
        composerOwner: 'automation',
        threadId: 'hidden-1',
        thread: null,
        mainThreadId: 'main',
        draftOwner: 'automation:schedule-1:hidden-1',
        actions: {
          busy: false,
          failures: [],
          execute: async () => undefined,
          retry: async () => undefined,
          dismiss: noop,
        },
        drafts: {
          getDraft: () => ({ id: 'draft', text: '不可见草稿' }),
          updateDraft: noop,
          completeDraft: noop,
          removeAttachment: noop,
          restoreQueueDraft: noop,
        },
        topicCards: [],
        previewRevision: 0,
        toolExpansionChoices: {},
        onToolExpansionChange: noop,
        onOpenTopic: noop,
        onOpenDirectory: noop,
        onOpenMain: noop,
        onCloseTopic: noop,
        onShowOrigin: noop,
        showNotice: noop,
      }),
    );
    expect(useThreadSync).toHaveBeenCalledWith(threadSyncManager, 'hidden-1', 'schedule-1');
    expect(html).toContain('conversation-automation');
    expect(html).not.toContain('conversation-topic');
    expect(html).toContain('真实定时 prompt');
    expect(html).not.toContain('session-compose');
    expect(html).not.toContain('编辑话题名称');
    expect(html).not.toContain('message-actions');
  });
});
