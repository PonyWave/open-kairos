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
        clients: {} as never,
        groups: [group('ws-1', 'Kairos 项目', '/srv/kairos', 2)],
        loading: false,
        error: null,
        onChanged: vi.fn(),
        onOpenThread: vi.fn(),
      }),
    );

    expect(markup).toContain('新建工作空间');
    expect(markup).toContain('工作目录');
    expect(markup).toContain('Kairos 项目');
    expect(markup).toContain('main · /srv/kairos');
    expect(markup).toContain('打开主对话');
    expect(markup).toContain('重命名');
  });

  it('renders the empty state without workspaces', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspacesPage, {
        clients: {} as never,
        groups: [],
        loading: false,
        error: null,
        onChanged: vi.fn(),
        onOpenThread: vi.fn(),
      }),
    );
    expect(markup).toContain('还没有工作空间。');
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
