import type { Thread, Workspace } from '@kairos/contracts';
import { type ReactNode, useState } from 'react';
import { AnimatedDisclosure } from './animated-disclosure.js';
import { Dropdown } from './dropdown.js';
import { EntityMark } from './entity-mark.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { TopicCard } from './thread-list-page.js';
import type { TopicSort } from './thread-preview-gateway.js';
import type { TopicCardView } from './thread-view.js';
import type { WorkspaceGroup } from './use-workspaces.js';

export function WorkspacesPage({
  groups,
  temporary,
  cards,
  cardsError = null,
  onCardsRetry,
  mainThreadId,
  loading,
  error,
  busy = false,
  onChanged,
  onOpenThread,
  onCreate,
  onEdit,
  onVisibility,
  onDelete,
  onNewTopic,
}: {
  groups: readonly WorkspaceGroup[];
  temporary: readonly Thread[];
  cards: readonly TopicCardView[];
  cardsError?: string | null;
  onCardsRetry?: () => void;
  mainThreadId: string | null;
  loading: boolean;
  error: string | null;
  busy?: boolean;
  onChanged: () => void;
  onOpenThread: (threadId: string) => void;
  onCreate: () => void;
  onEdit: (workspace: Workspace) => void;
  onVisibility: (workspace: Workspace) => void;
  onDelete: (group: WorkspaceGroup) => void;
  onNewTopic: (workspaceId: string | null) => void;
}) {
  const [sort, setSort] = useState<TopicSort>('lastMessageAt');
  const activityByThread = new Map(
    cards.map((card) => [card.thread.threadId, card.lastMessageAt ?? card.createdAt]),
  );
  const groupActivity = (group: WorkspaceGroup): bigint => {
    let latest = 0n;
    for (const thread of [group.mainThread, ...group.tasks]) {
      if (!thread) continue;
      const at = activityByThread.get(thread.threadId) ?? thread.updatedAt ?? thread.createdAt;
      const seconds = at?.seconds ?? 0n;
      if (seconds > latest) latest = seconds;
    }
    return latest;
  };
  const sortedGroups = [...groups].sort((left, right) => {
    const leftKey =
      sort === 'createdAt' ? (left.workspace?.createdAt?.seconds ?? 0n) : groupActivity(left);
    const rightKey =
      sort === 'createdAt' ? (right.workspace?.createdAt?.seconds ?? 0n) : groupActivity(right);
    return Number(rightKey - leftKey);
  });
  return (
    <section className="workspaces-page" aria-labelledby="workspaces-heading">
      <header className="page-heading">
        <div>
          <h1 id="workspaces-heading">全部工作空间</h1>
        </div>
        <div className="workspaces-heading-actions">
          <Dropdown<TopicSort>
            className="conversation-sort"
            triggerClassName="sort-trigger"
            label="排序方式"
            value={sort}
            align="end"
            trigger={
              <>
                <Icon name="history" className="i-sm" />
                <span>{sort === 'createdAt' ? '创建时间' : '更新时间'}</span>
                <Icon name="down" className="i-sm dropdown-chevron" />
              </>
            }
            items={[
              { value: 'lastMessageAt', label: '更新时间' },
              { value: 'createdAt', label: '创建时间' },
            ]}
            onSelect={setSort}
          />
          <button type="button" className="device-primary" onClick={onCreate}>
            <Icon name="plus" className="i-sm" />
            创建
          </button>
        </div>
      </header>
      {error && (
        <FailureNotice
          label="工作空间加载失败"
          message={error}
          busy={loading}
          onRetry={onChanged}
        />
      )}
      {cardsError && (
        <FailureNotice
          label="话题预览加载失败"
          message={cardsError}
          busy={false}
          onRetry={onCardsRetry ?? onChanged}
        />
      )}
      {loading && groups.length === 0 ? <p role="status">正在加载工作空间…</p> : null}
      {!loading && !error && groups.length === 0 ? (
        <div className="workspace-empty">
          <Icon name="folder" />
          <h2>还没有工作空间</h2>
          <p>选择一台设备和一个工作目录，将相关对话保存在一起。</p>
        </div>
      ) : null}
      <div className="workspace-overview">
        {sortedGroups.map(
          (group) =>
            group.workspace && (
              <WorkspaceOverviewGroup
                key={group.workspace.workspaceId}
                workspace={group.workspace}
                deviceName={group.deviceName}
                mainThread={group.mainThread}
                tasks={group.tasks}
                cards={cards}
                mainThreadId={mainThreadId}
                busy={busy}
                onOpenThread={onOpenThread}
                onNewTopic={() => onNewTopic(group.workspace?.workspaceId ?? null)}
                actions={
                  <>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`编辑 ${group.workspace.name}`}
                      title="编辑名称和描述"
                      disabled={busy}
                      onClick={() => group.workspace && onEdit(group.workspace)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`${group.workspace.hidden ? '显示' : '隐藏'} ${group.workspace.name}`}
                      title={group.workspace.hidden ? '显示在侧边栏' : '从侧边栏隐藏'}
                      aria-pressed={group.workspace.hidden}
                      disabled={busy}
                      onClick={() => group.workspace && onVisibility(group.workspace)}
                    >
                      <Icon name={group.workspace.hidden ? 'eyeOff' : 'eye'} />
                    </button>
                    <button
                      type="button"
                      className="icon-button workspace-delete"
                      aria-label={`删除 ${group.workspace.name}`}
                      title="删除空间及对话"
                      disabled={busy}
                      onClick={() => onDelete(group)}
                    >
                      <Icon name="trash" />
                    </button>
                  </>
                }
              />
            ),
        )}
        {temporary.length > 0 && (
          <WorkspaceOverviewGroup
            workspace={null}
            mainThread={null}
            tasks={temporary}
            cards={cards}
            mainThreadId={mainThreadId}
            onOpenThread={onOpenThread}
            onNewTopic={() => onNewTopic(null)}
            busy={busy}
          />
        )}
      </div>
    </section>
  );
}

function WorkspaceOverviewGroup({
  workspace,
  mainThread,
  deviceName,
  tasks,
  cards,
  mainThreadId,
  actions,
  busy,
  onOpenThread,
  onNewTopic,
}: {
  workspace: Workspace | null;
  mainThread: Thread | null;
  deviceName?: string | undefined;
  tasks: readonly Thread[];
  cards: readonly TopicCardView[];
  mainThreadId: string | null;
  actions?: ReactNode;
  busy: boolean;
  onOpenThread: (threadId: string) => void;
  onNewTopic: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = workspace?.name ?? '临时对话';
  const cardsByThread = new Map(cards.map((card) => [card.thread.threadId, card]));
  const sortedTasks = [...tasks].sort(
    (a, b) => Number(b.updatedAt?.seconds ?? 0n) - Number(a.updatedAt?.seconds ?? 0n),
  );
  return (
    <section className="workspace-overview-group" aria-label={name}>
      <div className="workspace-overview-row">
        {workspace && (
          <div
            className="workspace-breadcrumb"
            title={`${deviceName || workspace.envId} · ${workspace.path}`}
          >
            <Icon name="monitor" className="i-xs" />
            <span>{deviceName || (workspace.envId === 'main' ? '主环境' : workspace.envId)}</span>
            <Icon name="chevron" className="i-xs" />
            <code>{workspace.path}</code>
            {workspace.hidden && (
              <span className="workspace-hidden-label">
                <Icon name="eyeOff" className="i-xs" />
                已隐藏
              </span>
            )}
          </div>
        )}
        <div className="workspace-overview-heading">
          <button
            type="button"
            className="workspace-overview-toggle"
            aria-label={`${expanded ? '收起' : '展开'} ${name} 的话题`}
            aria-expanded={expanded}
            title={workspace ? `${deviceName || workspace.envId} · ${workspace.path}` : undefined}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name="chevron" className={`workspace-chevron${expanded ? ' expanded' : ''}`} />
            {mainThread ? <EntityMark threadId={mainThread.threadId} /> : <Icon name="chat" />}
            <span className="workspace-overview-title">
              <strong>{name}</strong>
              <span>{tasks.length} 个话题</span>
            </span>
          </button>
          <div className="workspace-overview-actions">{actions}</div>
        </div>
      </div>
      <AnimatedDisclosure open={expanded}>
        <div className="workspace-overview-topics">
          {workspace?.description && (
            <p className="workspace-overview-description">{workspace.description}</p>
          )}
          {mainThread && (
            <TopicCard
              card={cardsByThread.get(mainThread.threadId) ?? taskCard(mainThread)}
              sort="lastMessageAt"
              mainThreadId={mainThreadId}
              onOpen={(card) => onOpenThread(card.thread.threadId)}
            />
          )}
          {sortedTasks.map((task) => (
            <TopicCard
              key={task.threadId}
              card={cardsByThread.get(task.threadId) ?? taskCard(task)}
              sort="lastMessageAt"
              mainThreadId={mainThreadId}
              onOpen={(card) => onOpenThread(card.thread.threadId)}
            />
          ))}
          {tasks.length === 0 && <p className="workspace-no-topics">尚无话题。</p>}
          <button
            type="button"
            className="workspace-overview-new"
            disabled={busy}
            onClick={onNewTopic}
          >
            <Icon name="plus" className="i-sm" />
            {workspace ? '新建话题' : '新建临时对话'}
          </button>
        </div>
      </AnimatedDisclosure>
    </section>
  );
}

function taskCard(thread: Thread): TopicCardView {
  return {
    thread,
    createdAt: thread.createdAt,
    ...(thread.updatedAt === undefined ? {} : { lastMessageAt: thread.updatedAt }),
    replies: [],
    origin: null,
  };
}
