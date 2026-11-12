import { create, ThreadSchema, ThreadType, WorkspaceSchema } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TemporaryThreadsSection, WorkspaceGroupSection } from './sidebar-workspaces.js';

const noop = () => {};
const rename = async () => true;

const main = create(ThreadSchema, {
  threadId: 'ws-main',
  title: 'project-alpha',
  threadType: ThreadType.WORKSPACE_MAIN,
  workspaceId: 'ws-alpha',
});
const task = create(ThreadSchema, {
  threadId: 'task-1',
  title: '整理 README 结构',
  threadType: ThreadType.TASK,
  workspaceId: 'ws-alpha',
});
const temporary = create(ThreadSchema, {
  threadId: 'temp-1',
  title: '临时任务',
  threadType: ThreadType.TASK,
});

describe('sidebar workspace groups', () => {
  it('renders the workspace main as the group header with nested task conversations', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceGroupSection, {
        group: {
          workspace: create(WorkspaceSchema, {
            workspaceId: 'ws-alpha',
            name: 'project-alpha',
            envId: 'main',
            path: '/workspace/project-alpha',
            mainThreadId: 'ws-main',
          }),
          mainThread: main,
          tasks: [task],
        },
        selectedThreadId: 'ws-main',
        busy: false,
        onOpenThread: noop,
        onNewTopic: noop,
        onRename: rename,
      }),
    );
    expect(html).toContain('workspace-group-header current');
    expect(html).toContain('workspace-main-open');
    expect(html).toContain('project-alpha');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('workspace-tasks');
    expect(html).toContain('整理 README 结构');
    expect(html).toContain('在 project-alpha 新建话题');
  });

  it('marks the group header when a task conversation is selected instead', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceGroupSection, {
        group: {
          workspace: create(WorkspaceSchema, {
            workspaceId: 'ws-alpha',
            name: 'project-alpha',
            envId: 'main',
            path: '/workspace/project-alpha',
            mainThreadId: 'ws-main',
          }),
          mainThread: main,
          tasks: [task],
        },
        selectedThreadId: 'task-1',
        busy: false,
        onOpenThread: noop,
        onNewTopic: noop,
        onRename: rename,
      }),
    );
    expect(html).not.toContain('workspace-group-header current');
    expect(html).toContain('workspace-task-item current');
  });

  it('renders temporary conversations as a weaker group with line badges', () => {
    const html = renderToStaticMarkup(
      createElement(TemporaryThreadsSection, {
        threads: [temporary],
        selectedThreadId: null,
        busy: false,
        onOpenThread: noop,
        onNewTopic: noop,
        onRename: rename,
      }),
    );
    expect(html).toContain('临时对话');
    expect(html).toContain('workspace-group-header weaker');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('workspace-tasks');
    expect(html).toContain('临时任务');
    expect(html).toContain('thread-badge line');
  });

  it('shows only the three most recent tasks with an expand-all row', () => {
    const tasks = [1, 2, 3, 4].map((index) =>
      create(ThreadSchema, {
        threadId: `task-${index}`,
        title: `任务 ${index}`,
        threadType: ThreadType.TASK,
        workspaceId: 'ws-alpha',
        updatedAt: { seconds: BigInt(index), nanos: 0 },
      }),
    );
    const html = renderToStaticMarkup(
      createElement(WorkspaceGroupSection, {
        group: {
          workspace: create(WorkspaceSchema, {
            workspaceId: 'ws-alpha',
            name: 'project-alpha',
            envId: 'main',
            path: '/workspace/project-alpha',
            mainThreadId: 'ws-main',
          }),
          mainThread: main,
          tasks,
        },
        selectedThreadId: null,
        busy: false,
        onOpenThread: noop,
        onNewTopic: noop,
        onRename: rename,
      }),
    );
    expect(html).toContain('任务 4');
    expect(html).toContain('任务 3');
    expect(html).toContain('任务 2');
    expect(html).not.toContain('任务 1');
    expect(html).toContain('展开话题');
  });
});
