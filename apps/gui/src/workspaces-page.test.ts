import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThreadListPage } from './thread-list-page.js';
import type { TopicCardView } from './thread-view.js';
import type { WorkspaceGroup } from './use-workspaces.js';
import { WorkspacesPage } from './workspaces-page.js';

function group(workspaceId: string, name: string, path: string, tasks: number): WorkspaceGroup {
  return {
    workspace: {
      $typeName: 'kairos.gui.v1.Workspace',
      workspaceId,
      name,
      envId: 'main',
      path,
      createdAt: undefined,
      mainThreadId: `${workspaceId}-main`,
      description: '空间用途',
      hidden: false,
    },
    mainThread: {
      $typeName: 'kairos.gui.v1.Thread',
      threadId: `${workspaceId}-main`,
      title: name,
      seq: 1n,
      createdAt: undefined,
      updatedAt: undefined,
      threadType: 3,
      workspaceId,
    },
    tasks: Array.from({ length: tasks }, (_, index) => ({
      $typeName: 'kairos.gui.v1.Thread' as const,
      threadId: `${workspaceId}-task-${index}`,
      title: `任务 ${index}`,
      seq: BigInt(index + 2),
      createdAt: undefined,
      updatedAt: undefined,
      threadType: 2,
      workspaceId,
    })),
  };
}

function card(threadId: string, title: string, workspaceId?: string): TopicCardView {
  return {
    thread: {
      $typeName: 'kairos.gui.v1.Thread',
      threadId,
      title,
      seq: 1n,
      createdAt: undefined,
      updatedAt: undefined,
      threadType: 2,
      ...(workspaceId ? { workspaceId } : {}),
    },
    replies: [],
    origin: null,
  };
}

describe('WorkspacesPage', () => {
  it('renders the create form and existing workspace groups', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspacesPage, {
        temporary: [],
        cards: [],
        mainThreadId: 'main-1',
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onVisibility: vi.fn(),
        onDelete: vi.fn(),
        onNewTopic: vi.fn(),
        groups: [group('ws-1', 'Kairos 项目', '/srv/kairos', 2)],
        loading: false,
        error: null,
        onChanged: vi.fn(),
        onOpenThread: vi.fn(),
      }),
    );

    expect(markup).toContain('创建');
    expect(markup).toContain('aria-label="排序方式"');
    expect(markup).toContain('2 个话题');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('任务 0');
    expect(markup).toContain('/srv/kairos');
    expect(markup).toContain('Kairos 项目');
    expect(markup).not.toContain('空间用途');
    expect(markup).not.toContain('个主对话');
    expect(markup).toContain('编辑 Kairos 项目');
    expect(markup).toContain('隐藏 Kairos 项目');
    expect(markup).toContain('删除 Kairos 项目');
    expect(markup).not.toContain('临时对话');
  });

  it('lists the temporary group only when temporary conversations exist', () => {
    const temporaryThread = {
      $typeName: 'kairos.gui.v1.Thread' as const,
      threadId: 'tmp-1',
      title: '临时任务',
      seq: 9n,
      createdAt: undefined,
      updatedAt: undefined,
      threadType: 2,
    };
    const markup = renderToStaticMarkup(
      createElement(WorkspacesPage, {
        temporary: [temporaryThread],
        cards: [],
        mainThreadId: 'main-1',
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onVisibility: vi.fn(),
        onDelete: vi.fn(),
        onNewTopic: vi.fn(),
        groups: [group('ws-1', 'Kairos 项目', '/srv/kairos', 0)],
        loading: false,
        error: null,
        onChanged: vi.fn(),
        onOpenThread: vi.fn(),
      }),
    );
    expect(markup).toContain('临时对话');
    expect(markup).toContain('1 个话题');
    expect(markup).not.toContain('隐藏 临时对话');
  });

  it('orders workspace groups by the latest conversation activity by default', () => {
    const withActivity = (base: WorkspaceGroup, seconds: bigint): WorkspaceGroup => ({
      ...base,
      tasks: [
        {
          $typeName: 'kairos.gui.v1.Thread',
          threadId: `${base.workspace?.workspaceId ?? ''}-task`,
          title: '话题',
          seq: 9n,
          createdAt: undefined,
          updatedAt: { $typeName: 'google.protobuf.Timestamp', seconds, nanos: 0 },
          threadType: 2,
        },
      ],
    });
    const stale = withActivity(group('ws-1', '旧空间', '/srv/old', 0), 100n);
    const active = withActivity(group('ws-2', '活跃空间', '/srv/new', 0), 300n);
    const markup = renderToStaticMarkup(
      createElement(WorkspacesPage, {
        temporary: [],
        cards: [],
        mainThreadId: 'main-1',
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onVisibility: vi.fn(),
        onDelete: vi.fn(),
        onNewTopic: vi.fn(),
        groups: [stale, active],
        loading: false,
        error: null,
        onChanged: vi.fn(),
        onOpenThread: vi.fn(),
      }),
    );
    expect(markup.indexOf('活跃空间')).toBeLessThan(markup.indexOf('旧空间'));
  });

  it('renders the empty state without workspaces', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspacesPage, {
        temporary: [],
        cards: [],
        mainThreadId: 'main-1',
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onVisibility: vi.fn(),
        onDelete: vi.fn(),
        onNewTopic: vi.fn(),
        groups: [],
        loading: false,
        error: null,
        onChanged: vi.fn(),
        onOpenThread: vi.fn(),
      }),
    );
    expect(markup).toContain('还没有工作空间');
  });
});

describe('ThreadListPage workspace sections', () => {
  it('groups cards by workspace and lists temporary conversations separately', () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadListPage, {
        cards: [
          card('t-1', '甲任务', 'ws-1'),
          card('t-2', '乙任务', 'ws-1'),
          card('t-3', '临时任务'),
        ],
        sort: 'lastMessageAt',
        mainThreadId: 'main-1',
        loading: false,
        error: null,
        hasMore: false,
        workspaceNames: new Map([['ws-1', 'Kairos 项目']]),
        onOpen: vi.fn(),
        onSort: vi.fn(),
        onLoadMore: vi.fn(async () => {}),
        onReload: vi.fn(async () => {}),
        onManageWorkspaces: vi.fn(),
      }),
    );

    expect(markup).toContain('Kairos 项目');
    expect(markup).toContain('临时对话');
    expect(markup).toContain('甲任务');
    expect(markup).toContain('临时任务');
  });

  it('renders a flat list when no workspace metadata is available', () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadListPage, {
        cards: [card('t-1', '任务一')],
        sort: 'lastMessageAt',
        mainThreadId: 'main-1',
        loading: false,
        error: null,
        hasMore: false,
        onOpen: vi.fn(),
        onSort: vi.fn(),
        onLoadMore: vi.fn(async () => {}),
        onReload: vi.fn(async () => {}),
        onManageWorkspaces: vi.fn(),
      }),
    );
    expect(markup).toContain('任务一');
    expect(markup).not.toContain('临时对话');
  });
});
