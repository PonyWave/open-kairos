import { useState } from 'react';
import { AnimatedDisclosure } from './animated-disclosure.js';
import { ContextMenu, type ContextMenuItem } from './context-menu.js';
import { EntityMark, ThreadBadge } from './entity-mark.js';
import { Icon } from './icon.js';
import { TitleEditor } from './thread-title.js';
import type { WorkspaceGroup } from './use-workspaces.js';

export function WorkspaceGroupSection({
  group,
  selectedThreadId,
  busy,
  onOpenThread,
  onNewTopic,
  onRename,
  onArchiveThread,
  onEditWorkspace,
  onDeleteWorkspace,
  onRenameWorkspace,
  onClearWorkspaceMain,
}: {
  group: WorkspaceGroup;
  selectedThreadId: string | null;
  busy: boolean;
  onOpenThread: (threadId: string) => void;
  onNewTopic: () => void;
  onRename: (threadId: string, title: string) => Promise<boolean>;
  onArchiveThread: (threadId: string) => void;
  onEditWorkspace: () => void;
  onDeleteWorkspace: () => void;
  onRenameWorkspace: (name: string) => Promise<boolean>;
  onClearWorkspaceMain: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const main = group.mainThread;
  const name = group.workspace?.name ?? '工作空间';
  const mainCurrent = main !== null && selectedThreadId === main.threadId;
  const sortedTasks = [...group.tasks].sort(
    (left, right) => Number(right.updatedAt?.seconds ?? 0n) - Number(left.updatedAt?.seconds ?? 0n),
  );
  const visibleTasks = showAll ? sortedTasks : sortedTasks.slice(0, 3);
  const hiddenCount = sortedTasks.length - visibleTasks.length;
  const menuItems: ContextMenuItem[] = [
    { key: 'edit', label: '编辑工作空间', icon: 'edit', onSelect: onEditWorkspace },
    {
      key: 'rename',
      label: '重命名工作空间',
      icon: 'edit',
      onSelect: () => setRenaming(true),
    },
    {
      key: 'clear-main',
      label: '清空主对话上下文',
      icon: 'history',
      disabled: main === null,
      onSelect: onClearWorkspaceMain,
    },
    {
      key: 'delete',
      label: '删除工作空间',
      icon: 'trash',
      danger: true,
      onSelect: onDeleteWorkspace,
    },
  ];
  return (
    <div className="workspace-group">
      <div
        className={`workspace-group-header${mainCurrent ? ' current' : ''}`}
        title={group.workspace ? `${group.workspace.envId} · ${group.workspace.path}` : undefined}
        onContextMenu={(event) => {
          if (!group.workspace) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? `收起 ${name} 的对话` : `展开 ${name} 的对话`}
          aria-expanded={expanded}
          onClick={() =>
            setExpanded((value) => {
              if (value) setShowAll(false);
              return !value;
            })
          }
        >
          <Icon name="chevron" className={`i-sm workspace-chevron${expanded ? ' expanded' : ''}`} />
        </button>
        {renaming && group.workspace ? (
          <span className="workspace-main-open workspace-rename-editor">
            <EntityMark threadId={main?.threadId} className="workspace-avatar" />
            <TitleEditor
              title={name}
              busy={busy}
              onCancel={() => setRenaming(false)}
              onSave={async (next) => {
                const saved = await onRenameWorkspace(next);
                if (saved) setRenaming(false);
                return saved;
              }}
            />
          </span>
        ) : main ? (
          <button
            type="button"
            className="workspace-main-open"
            aria-current={mainCurrent ? 'page' : undefined}
            onClick={() => onOpenThread(main.threadId)}
          >
            <EntityMark threadId={main.threadId} className="workspace-avatar" />
            <span className="workspace-name">{name}</span>
          </button>
        ) : (
          <span className="workspace-main-open">
            <EntityMark className="workspace-avatar" />
            <span className="workspace-name">{name}</span>
          </span>
        )}
        <span className="workspace-group-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={`在 ${name} 新建话题`}
            title="新建话题"
            onClick={onNewTopic}
          >
            <Icon name="plus" className="i-sm" />
          </button>
        </span>
      </div>
      {!main && <p className="muted">工作空间主对话缺失</p>}
      <AnimatedDisclosure open={expanded && visibleTasks.length > 0}>
        <div className="workspace-tasks">
          {visibleTasks.map((thread) => (
            <WorkspaceTaskItem
              key={thread.threadId}
              thread={thread}
              current={selectedThreadId === thread.threadId}
              busy={busy}
              onOpen={() => onOpenThread(thread.threadId)}
              onRename={(title) => onRename(thread.threadId, title)}
              onArchive={() => onArchiveThread(thread.threadId)}
            />
          ))}
          {hiddenCount > 0 && (
            <button type="button" className="workspace-task-more" onClick={() => setShowAll(true)}>
              展开话题
            </button>
          )}
        </div>
      </AnimatedDisclosure>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function WorkspaceTaskItem({
  thread,
  current,
  busy,
  line = false,
  onOpen,
  onRename,
  onArchive,
}: {
  thread: WorkspaceGroup['tasks'][number];
  current: boolean;
  busy: boolean;
  line?: boolean | undefined;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuItems: ContextMenuItem[] = [
    { key: 'rename', label: '编辑', icon: 'edit', onSelect: () => setEditing(true) },
    { key: 'archive', label: '归档', icon: 'archive', onSelect: onArchive },
  ];
  return (
    <div
      className={`workspace-task-item${current ? ' current' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <ThreadBadge threadId={thread.threadId} line={line} className="workspace-task-badge" />
      {editing ? (
        <TitleEditor
          title={thread.title}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (title) => {
            const saved = await onRename(title);
            if (saved) setEditing(false);
            return saved;
          }}
        />
      ) : (
        <button
          type="button"
          className="workspace-task-open"
          title={`${thread.title} · 双击编辑名称`}
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
        >
          {thread.title || '未命名话题'}
        </button>
      )}
      {!editing && (
        <span className="workspace-task-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={`编辑 ${thread.title || '未命名话题'}`}
            title="编辑名称"
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" className="i-xs" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`归档 ${thread.title || '未命名话题'}`}
            title="归档话题"
            disabled={busy}
            onClick={onArchive}
          >
            <Icon name="archive" className="i-xs" />
          </button>
        </span>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

export function TemporaryThreadsSection({
  threads,
  selectedThreadId,
  busy,
  onOpenThread,
  onNewTopic,
  onRename,
  onArchiveThread,
}: {
  threads: WorkspaceGroup['tasks'];
  selectedThreadId: string | null;
  busy: boolean;
  onOpenThread: (threadId: string) => void;
  onNewTopic: () => void;
  onRename: (threadId: string, title: string) => Promise<boolean>;
  onArchiveThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (threads.length === 0) return null;
  const sortedThreads = [...threads].sort(
    (left, right) => Number(right.updatedAt?.seconds ?? 0n) - Number(left.updatedAt?.seconds ?? 0n),
  );
  const visibleThreads = showAll ? sortedThreads : sortedThreads.slice(0, 3);
  const hiddenCount = sortedThreads.length - visibleThreads.length;
  return (
    <div className="workspace-group">
      <div className="workspace-group-header weaker">
        <span className="workspace-main-open">
          <span className="workspace-name">临时对话</span>
        </span>
        <span className="workspace-group-actions">
          {
            <button
              type="button"
              className="icon-button"
              aria-label={expanded ? '收起临时对话' : '展开临时对话'}
              aria-expanded={expanded}
              onClick={() =>
                setExpanded((value) => {
                  if (value) setShowAll(false);
                  return !value;
                })
              }
            >
              <Icon
                name="chevron"
                className={`i-sm workspace-chevron${expanded ? ' expanded' : ''}`}
              />
            </button>
          }
          <button
            type="button"
            className="icon-button"
            aria-label="新建临时对话"
            title="新建临时对话"
            onClick={onNewTopic}
          >
            <Icon name="plus" className="i-sm" />
          </button>
        </span>
      </div>
      <AnimatedDisclosure open={expanded && visibleThreads.length > 0}>
        <div className="workspace-tasks">
          {visibleThreads.map((thread) => (
            <WorkspaceTaskItem
              key={thread.threadId}
              thread={thread}
              current={selectedThreadId === thread.threadId}
              busy={busy}
              line
              onOpen={() => onOpenThread(thread.threadId)}
              onRename={(title) => onRename(thread.threadId, title)}
              onArchive={() => onArchiveThread(thread.threadId)}
            />
          ))}
          {hiddenCount > 0 && (
            <button type="button" className="workspace-task-more" onClick={() => setShowAll(true)}>
              展开话题
            </button>
          )}
        </div>
      </AnimatedDisclosure>
    </div>
  );
}
