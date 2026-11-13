import {
  type Automation,
  type AutomationFire,
  AutomationTargetKind,
  type CreateAutomationResponse,
  type DeleteAutomationResponse,
  type RunAutomationNowResponse,
  type Thread,
  type UpdateAutomationResponse,
  type Workspace,
} from '@kairos/contracts';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { AppDialog } from './app-dialog.js';
import {
  type AutomationFormValue,
  automationDefinitionPayload,
  automationFireStatusText,
  automationFormValue,
  automationScheduleText,
  automationTargetText,
  automationTimestampText,
  automationTriggerText,
  newAutomationForm,
  requireAutomation,
} from './automation-model.js';
import {
  AutomationListController,
  type AutomationListState,
  getAutomation,
  listAutomationFires,
  listOrdinaryThreads,
} from './automation-requests.js';
import {
  automationRepeatLabel,
  automationRepeatOptions,
  automationWeekdays,
} from './automation-schedule.js';
import { automationTimeZoneLabel, automationTimeZoneOptions } from './automation-time-zone.js';
import type { KairosClients } from './client.js';
import { DelayedStatus } from './delayed-status.js';
import { Dropdown, dropdownPosition } from './dropdown.js';
import { formatClientError } from './errors.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { randomId } from './random.js';
import type { ActionExecutorView } from './use-action-executor.js';

interface AutomationDetailState {
  scheduleId: string;
  automation: Automation | null;
  loading: boolean;
  error: string | null;
}

interface AutomationFireState {
  scheduleId: string;
  fires: AutomationFire[];
  nextSeq: bigint | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export function AutomationPage({
  clients,
  actions,
  mainThreadId,
  selectedScheduleId,
  revision,
  onSelect,
  onOpenThread,
}: {
  clients: KairosClients;
  actions: ActionExecutorView;
  mainThreadId: string;
  selectedScheduleId: string | null;
  revision: number;
  onSelect: (scheduleId: string | null) => void;
  onOpenThread: (scheduleId: string, threadId: string, automationOnly: boolean) => void;
}) {
  const listStore = useMemo(() => new AutomationListController(clients), [clients]);
  const list = useSyncExternalStore(listStore.subscribe, listStore.snapshot, listStore.snapshot);
  const [detail, setDetail] = useState<AutomationDetailState | null>(null);
  const [history, setHistory] = useState<AutomationFireState | null>(null);
  const [editor, setEditor] = useState<{ session: string; automation: Automation | null } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const deleteRecovery = useRef<{ scheduleId: string; revision: number } | null>(null);
  const detailGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const historyController = useRef<AbortController | null>(null);

  const loadHistory = useCallback(
    async (scheduleId: string, afterSeq = 0n, append = false) => {
      const generation = ++historyGeneration.current;
      historyController.current?.abort();
      const controller = new AbortController();
      historyController.current = controller;
      setHistory((current) => ({
        scheduleId,
        fires: append && current?.scheduleId === scheduleId ? current.fires : [],
        nextSeq: append && current?.scheduleId === scheduleId ? current.nextSeq : null,
        hasMore: append && current?.scheduleId === scheduleId ? current.hasMore : false,
        loading: true,
        error: null,
      }));
      try {
        const page = await listAutomationFires(
          clients,
          scheduleId,
          afterSeq,
          50,
          controller.signal,
        );
        if (generation !== historyGeneration.current) return;
        setHistory((current) => ({
          scheduleId,
          fires:
            append && current?.scheduleId === scheduleId
              ? mergeFires(current.fires, page.fires)
              : page.fires,
          nextSeq: page.nextSeq,
          hasMore: page.hasMore,
          loading: false,
          error: null,
        }));
      } catch (cause) {
        if (generation !== historyGeneration.current || controller.signal.aborted) return;
        setHistory((current) => ({
          scheduleId,
          fires: current?.scheduleId === scheduleId ? current.fires : [],
          nextSeq: current?.scheduleId === scheduleId ? current.nextSeq : null,
          hasMore: current?.scheduleId === scheduleId ? current.hasMore : false,
          loading: false,
          error: formatClientError(cause),
        }));
      }
    },
    [clients],
  );

  useEffect(() => {
    void revision;
    void listStore.load();
    return () => listStore.stop();
  }, [listStore, revision]);

  useEffect(() => {
    void revision;
    void detailRefresh;
    if (!selectedScheduleId) {
      setDetail(null);
      return;
    }
    const generation = ++detailGeneration.current;
    const controller = new AbortController();
    detailController.current?.abort();
    detailController.current = controller;
    setDetail((current) => ({
      scheduleId: selectedScheduleId,
      automation: current?.scheduleId === selectedScheduleId ? current.automation : null,
      loading: true,
      error: null,
    }));
    void getAutomation(clients, selectedScheduleId, controller.signal).then(
      (automation) => {
        if (generation !== detailGeneration.current) return;
        setDetail({ scheduleId: selectedScheduleId, automation, loading: false, error: null });
      },
      (cause: unknown) => {
        if (generation !== detailGeneration.current || controller.signal.aborted) return;
        setDetail((current) => ({
          scheduleId: selectedScheduleId,
          automation: current?.scheduleId === selectedScheduleId ? current.automation : null,
          loading: false,
          error: formatClientError(cause),
        }));
      },
    );
    return () => {
      ++detailGeneration.current;
      controller.abort();
    };
  }, [clients, revision, selectedScheduleId, detailRefresh]);

  useEffect(() => {
    void revision;
    if (!selectedScheduleId) {
      setHistory(null);
      return;
    }
    void loadHistory(selectedScheduleId);
    return () => {
      ++historyGeneration.current;
      historyController.current?.abort();
    };
  }, [loadHistory, revision, selectedScheduleId]);

  useEffect(() => {
    if (!deleting) {
      deleteRecovery.current = null;
      return;
    }
    const pending = actions.failures.some(
      (failure) =>
        failure.key === `automation:delete:${deleting.scheduleId}` && failure.outcome === 'unknown',
    );
    if (pending) {
      deleteRecovery.current = { scheduleId: deleting.scheduleId, revision };
      return;
    }
    if (
      deleteRecovery.current?.scheduleId === deleting.scheduleId &&
      deleteRecovery.current.revision !== revision
    ) {
      deleteRecovery.current = null;
      setDeleting(null);
      onSelect(null);
    }
  }, [actions.failures, deleting, onSelect, revision]);

  const selectedAutomation =
    detail?.scheduleId === selectedScheduleId
      ? detail.automation
      : (list.automations.find((automation) => automation.scheduleId === selectedScheduleId) ??
        null);
  const selectedHistory = history?.scheduleId === selectedScheduleId ? history : null;

  async function toggle(automation: Automation): Promise<void> {
    const response = await actions.execute<UpdateAutomationResponse>(
      `automation:enabled:${automation.scheduleId}`,
      'updateAutomation',
      {
        scheduleId: automation.scheduleId,
        expectedVersion: automation.version.toString(),
        enabled: !automation.enabled,
      },
    );
    if (response?.automation) {
      const saved = requireAutomation(response.automation);
      setDetail({ scheduleId: saved.scheduleId, automation: saved, loading: false, error: null });
    }
  }

  async function runNow(automation: Automation): Promise<void> {
    const response = await actions.execute<RunAutomationNowResponse>(
      `automation:run:${automation.scheduleId}`,
      'runAutomationNow',
      { scheduleId: automation.scheduleId },
    );
    if (response?.fire && selectedScheduleId) await loadHistory(selectedScheduleId);
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    const response = await actions.execute<DeleteAutomationResponse>(
      `automation:delete:${deleting.scheduleId}`,
      'deleteAutomation',
      {
        scheduleId: deleting.scheduleId,
        expectedVersion: deleting.version.toString(),
      },
    );
    if (response?.deleted) {
      setDeleting(null);
      onSelect(null);
    }
  }

  return (
    <section className="automation-page" aria-labelledby="automation-heading">
      <header className="automation-page-heading">
        <div>
          <h1 id="automation-heading">定时任务</h1>
          <p>按明确时区提交提示词，并核对每次执行的实际状态。</p>
        </div>
        {!selectedScheduleId && (
          <button
            type="button"
            className="device-primary"
            disabled={actions.busy}
            onClick={() => setEditor({ session: randomId(), automation: null })}
          >
            <Icon name="plus" className="i-sm" />
            新建
          </button>
        )}
      </header>
      {!selectedScheduleId ? (
        <AutomationListView
          state={list}
          busy={actions.busy}
          pendingFailures={actions.failures}
          onSelect={onSelect}
          onRun={(automation) => void runNow(automation)}
          onReload={() => void listStore.load()}
          onLoadMore={() => void listStore.load(true)}
        />
      ) : (
        <div className="automation-detail">
          <button type="button" className="automation-back" onClick={() => onSelect(null)}>
            <Icon name="back" className="i-sm" />
            全部定时任务
          </button>
          {detail?.error && (
            <FailureNotice
              label="定时任务读取失败"
              message={detail.error}
              busy={detail.loading}
              onRetry={() => setDetailRefresh((value) => value + 1)}
            />
          )}
          {detail?.loading && !selectedAutomation ? (
            <p role="status">正在读取定时任务…</p>
          ) : selectedAutomation ? (
            <>
              <section className="automation-definition" aria-labelledby="automation-name">
                <div className="automation-definition-heading">
                  <div>
                    <div className="automation-title-line">
                      <h2 id="automation-name">{selectedAutomation.name}</h2>
                      <span
                        className={`automation-enabled${selectedAutomation.enabled ? '' : ' disabled'}`}
                      >
                        {selectedAutomation.enabled ? '已启用' : '已停用'}
                      </span>
                    </div>
                    <p>{automationScheduleText(selectedAutomation)}</p>
                  </div>
                  <div className="automation-actions">
                    <button
                      type="button"
                      className="icon-button automation-action"
                      aria-label="立即执行"
                      title="立即执行"
                      disabled={actionUnavailable(
                        actions,
                        `automation:run:${selectedAutomation.scheduleId}`,
                      )}
                      onClick={() => void runNow(selectedAutomation)}
                    >
                      <Icon name="play" className="i-sm" />
                    </button>
                    <button
                      type="button"
                      className="icon-button automation-action"
                      aria-label="修改"
                      title="修改"
                      disabled={actionUnavailable(
                        actions,
                        `automation:update:${selectedAutomation.scheduleId}`,
                      )}
                      onClick={() =>
                        setEditor({ session: randomId(), automation: selectedAutomation })
                      }
                    >
                      <Icon name="edit" className="i-sm" />
                    </button>
                    <button
                      type="button"
                      className="icon-button automation-action"
                      aria-label={selectedAutomation.enabled ? '停用' : '启用'}
                      title={selectedAutomation.enabled ? '停用' : '启用'}
                      disabled={actionUnavailable(
                        actions,
                        `automation:enabled:${selectedAutomation.scheduleId}`,
                      )}
                      onClick={() => void toggle(selectedAutomation)}
                    >
                      <Icon name={selectedAutomation.enabled ? 'pause' : 'play'} className="i-sm" />
                    </button>
                    <button
                      type="button"
                      className="icon-button automation-action automation-delete"
                      aria-label="删除"
                      title="删除"
                      disabled={actionUnavailable(
                        actions,
                        `automation:delete:${selectedAutomation.scheduleId}`,
                      )}
                      onClick={() => setDeleting(selectedAutomation)}
                    >
                      <Icon name="trash" className="i-sm" />
                    </button>
                  </div>
                </div>
                <dl className="automation-definition-grid">
                  <div>
                    <dt>触发话题</dt>
                    <dd>{automationTargetText(selectedAutomation.target?.kind)}</dd>
                  </div>
                  <div>
                    <dt>下次定时触发</dt>
                    <dd>
                      {selectedAutomation.enabled && selectedAutomation.nextFireAt
                        ? automationTimestampText(selectedAutomation.nextFireAt)
                        : '无待执行的定时触发'}
                    </dd>
                  </div>
                </dl>
                <div className="automation-prompt">
                  <span>提示词</span>
                  <p>{selectedAutomation.prompt}</p>
                </div>
                {currentTarget(selectedAutomation, mainThreadId) && (
                  <button
                    type="button"
                    className="automation-target-link"
                    onClick={() =>
                      onOpenThread(
                        selectedAutomation.scheduleId,
                        currentTarget(selectedAutomation, mainThreadId) ?? '',
                        false,
                      )
                    }
                  >
                    打开当前目标 Thread
                    <Icon name="chevron" className="i-sm" />
                  </button>
                )}
              </section>
              <AutomationFireHistory
                state={selectedHistory}
                busy={actions.busy}
                onOpenThread={onOpenThread}
                onReload={() => void loadHistory(selectedAutomation.scheduleId)}
                onLoadMore={() =>
                  void loadHistory(
                    selectedAutomation.scheduleId,
                    selectedHistory?.nextSeq ?? 0n,
                    true,
                  )
                }
              />
            </>
          ) : !detail?.error ? (
            <DelayedStatus>
              <p role="status">正在读取定时任务…</p>
            </DelayedStatus>
          ) : null}
        </div>
      )}
      {editor && (
        <AutomationEditor
          key={`${editor.session}:${editor.automation?.scheduleId ?? 'new'}`}
          clients={clients}
          actions={actions}
          automation={editor.automation}
          session={editor.session}
          revision={revision}
          onClose={() => setEditor(null)}
          onSaved={(automation) => {
            setEditor(null);
            onSelect(automation.scheduleId);
          }}
        />
      )}
      {deleting && (
        <AppDialog
          title={`删除“${deleting.name}”？`}
          subtitle="删除后不再触发，既有执行记录和 Thread 继续保留。"
          closeDisabled={actions.busy}
          onClose={() => setDeleting(null)}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                disabled={actions.busy}
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="device-primary device-danger"
                disabled={actionUnavailable(actions, `automation:delete:${deleting.scheduleId}`)}
                onClick={() => void remove()}
              >
                删除定时任务
              </button>
            </>
          }
        >
          <p>删除操作使用当前定义版本。版本冲突时请先刷新定时任务。</p>
        </AppDialog>
      )}
    </section>
  );
}

export function AutomationListView({
  state,
  busy,
  pendingFailures,
  onSelect,
  onRun,
  onReload,
  onLoadMore,
}: {
  state: AutomationListState;
  busy: boolean;
  pendingFailures: ActionExecutorView['failures'];
  onSelect: (scheduleId: string) => void;
  onRun: (automation: Automation) => void;
  onReload: () => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="automation-list-section">
      {state.error && (
        <FailureNotice
          label="定时任务列表读取失败"
          message={state.error}
          busy={state.loading}
          onRetry={onReload}
        />
      )}
      {state.loading && state.automations.length === 0 ? (
        <DelayedStatus>
          <p role="status">正在加载定时任务…</p>
        </DelayedStatus>
      ) : state.automations.length === 0 && !state.error ? (
        <div className="automation-empty">
          <Icon name="clock" className="i-lg" />
          <h2>尚未创建定时任务</h2>
          <p>设置重复方式和时间，按计划执行任务，也可随时立即执行。</p>
        </div>
      ) : (
        <ul className="automation-list" aria-label="定时任务列表">
          {state.automations.map((automation) => (
            <li className="automation-row" key={automation.scheduleId}>
              <button
                type="button"
                className="automation-row-main"
                onClick={() => onSelect(automation.scheduleId)}
              >
                <span className="automation-row-title">
                  <strong>{automation.name}</strong>
                  <span className={`automation-enabled${automation.enabled ? '' : ' disabled'}`}>
                    {automation.enabled ? '已启用' : '已停用'}
                  </span>
                </span>
                <span>{automationScheduleText(automation)}</span>
                {automation.enabled && automation.nextFireAt && (
                  <span>下次触发 {automationTimestampText(automation.nextFireAt)}</span>
                )}
                <span>{automationTargetText(automation.target?.kind)}</span>
              </button>
              <button
                type="button"
                className="device-secondary automation-run-compact"
                disabled={
                  busy ||
                  pendingFailures.some(
                    (failure) =>
                      failure.key === `automation:run:${automation.scheduleId}` &&
                      failure.outcome === 'unknown',
                  )
                }
                onClick={() => onRun(automation)}
                aria-label={`立即执行 ${automation.name}`}
              >
                <Icon name="play" className="i-sm" />
                立即执行
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.hasMore && (
        <button
          type="button"
          className="device-secondary automation-more"
          disabled={state.loading}
          onClick={onLoadMore}
        >
          {state.loading ? '正在加载…' : '加载更多定时任务'}
        </button>
      )}
    </div>
  );
}

export function AutomationFireHistory({
  state,
  busy,
  onOpenThread,
  onReload,
  onLoadMore,
}: {
  state: AutomationFireState | null;
  busy: boolean;
  onOpenThread: (scheduleId: string, threadId: string, automationOnly: boolean) => void;
  onReload: () => void;
  onLoadMore: () => void;
}) {
  const fires = state?.fires ?? [];
  return (
    <section className="automation-history" aria-labelledby="automation-history-heading">
      <div className="automation-section-heading">
        <div>
          <h2 id="automation-history-heading">执行历史</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新执行历史"
          disabled={busy || state?.loading}
          onClick={onReload}
        >
          <Icon name="retry" className={state?.loading ? 'spinning' : ''} />
        </button>
      </div>
      {state?.error && (
        <FailureNotice
          label="执行历史读取失败"
          message={state.error}
          busy={state.loading}
          onRetry={onReload}
        />
      )}
      {state?.loading && fires.length === 0 ? (
        <DelayedStatus>
          <p role="status">正在读取执行历史…</p>
        </DelayedStatus>
      ) : fires.length === 0 && !state?.error ? (
        <p className="automation-history-empty">尚无执行记录。</p>
      ) : (
        <div className="automation-fire-list">
          {fires.map((fire) => (
            <article className="automation-fire" key={fire.fireId}>
              <div className="automation-fire-main">
                <div className="automation-fire-heading">
                  <div>
                    <strong>{automationTriggerText(fire.trigger)}</strong>
                    <time>{automationTimestampText(fire.actualAt)}</time>
                  </div>
                  <span className={`automation-fire-status status-${fire.status}`}>
                    {automationFireStatusText(fire.status)}
                  </span>
                </div>
                <dl className="automation-fire-facts">
                  <div>
                    <dt>计划时间</dt>
                    <dd>{automationTimestampText(fire.scheduledAt)}</dd>
                  </div>
                  {fire.targetThreadId && (
                    <div>
                      <dt>
                        {fire.targetKind === AutomationTargetKind.NEW_TASK ||
                        fire.targetKind === AutomationTargetKind.NEW_AUTOMATION_ONLY
                          ? '新话题'
                          : '话题'}
                      </dt>
                      <dd>
                        {fire.targetKind === AutomationTargetKind.MAIN
                          ? '主对话'
                          : fire.targetThreadTitle || '未命名话题'}
                      </dd>
                    </div>
                  )}
                  {fire.finishedAt && (
                    <div>
                      <dt>结束时间</dt>
                      <dd>{automationTimestampText(fire.finishedAt)}</dd>
                    </div>
                  )}
                  {fire.coalescedCount > 0 && (
                    <div>
                      <dt>重复计划合并</dt>
                      <dd>额外合并 {fire.coalescedCount} 次较早计划</dd>
                    </div>
                  )}
                </dl>
                {fire.error && (
                  <div className="automation-fire-error" role="alert">
                    <strong>执行错误</strong>
                    <p>{fire.error.message || 'Server 未提供错误正文。'}</p>
                    <details className="automation-fire-error-detail">
                      <summary>技术详情</summary>
                      <code>error_code={fire.error.code}</code>
                    </details>
                  </div>
                )}
              </div>
              {fire.targetThreadId && (
                <button
                  type="button"
                  className="automation-target-link automation-fire-open"
                  onClick={() =>
                    onOpenThread(
                      fire.scheduleId,
                      fire.targetThreadId ?? '',
                      fire.targetKind === AutomationTargetKind.NEW_AUTOMATION_ONLY,
                    )
                  }
                >
                  查看对话
                  <Icon name="chevron" className="i-sm" />
                </button>
              )}
            </article>
          ))}
        </div>
      )}
      {state?.hasMore && (
        <button
          type="button"
          className="device-secondary automation-more"
          disabled={state.loading}
          onClick={onLoadMore}
        >
          {state.loading ? '正在加载…' : '加载后续执行记录'}
        </button>
      )}
    </section>
  );
}

function AutomationTimeFields({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [hour = '09', minute = '00'] = value.split(':');
  return (
    <span className="automation-time-fields">
      <Dropdown
        label="时间小时"
        trigger={
          <>
            {hour}
            <Icon name="down" className="i-sm dropdown-chevron" />
          </>
        }
        triggerClassName="device-secondary automation-select automation-time-part"
        value={hour}
        items={Array.from({ length: 24 }, (_, v) => {
          const padded = String(v).padStart(2, '0');
          return { value: padded, label: `${padded} 时` };
        })}
        disabled={disabled}
        onSelect={(next) => onChange(`${next}:${minute}`)}
      />
      <span className="automation-time-separator" aria-hidden="true">
        :
      </span>
      <Dropdown
        label="时间分钟"
        trigger={
          <>
            {minute}
            <Icon name="down" className="i-sm dropdown-chevron" />
          </>
        }
        triggerClassName="device-secondary automation-select automation-time-part"
        value={minute}
        items={Array.from({ length: 60 }, (_, v) => {
          const padded = String(v).padStart(2, '0');
          return { value: padded, label: `${padded} 分` };
        })}
        disabled={disabled}
        onSelect={(next) => onChange(`${hour}:${next}`)}
      />
    </span>
  );
}

function WorkspaceThreadCascade({
  threads,
  workspaces,
  value,
  loading,
  disabled,
  onSelect,
}: {
  threads: readonly Thread[];
  workspaces: readonly Workspace[];
  value: string;
  loading: boolean;
  disabled: boolean;
  onSelect: (threadId: string) => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byWorkspace = new Map<string, Thread[]>();
    for (const thread of threads) {
      const key = thread.workspaceId ?? '';
      byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), thread]);
    }
    return [
      ...workspaces.map((workspace) => ({
        id: workspace.workspaceId,
        name: workspace.name,
        threads: byWorkspace.get(workspace.workspaceId) ?? [],
      })),
      { id: '', name: '临时对话', threads: byWorkspace.get('') ?? [] },
    ];
  }, [threads, workspaces]);
  const active = groups.find((group) => group.id === groupId) ?? null;
  const selected = threads.find((thread) => thread.threadId === value);
  const close = useCallback(() => {
    setOpen(false);
    setGroupId(null);
  }, []);

  useLayoutEffect(() => {
    void groupId;
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    panel.style.minWidth = `${Math.min(Math.max(anchor.width, 220), window.innerWidth - 24)}px`;
    const bounds = panel.getBoundingClientRect();
    const result = dropdownPosition(
      anchor,
      { width: bounds.width, height: Math.max(bounds.height, panel.scrollHeight) },
      { width: window.innerWidth, height: window.innerHeight },
      'bottom',
      'start',
    );
    panel.style.left = `${result.left}px`;
    panel.style.top = `${result.top}px`;
    panel.style.maxHeight = `${result.maxHeight}px`;
  }, [open, groupId]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: Event) {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !panelRef.current?.contains(event.target)
      )
        close();
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, close]);

  const triggerLabel = loading
    ? '正在加载话题…'
    : selected?.title ||
      (value
        ? '当前话题'
        : groups.every((group) => group.threads.length === 0)
          ? '暂无可选话题'
          : '请选择话题');

  return (
    <div className="dropdown automation-cascade">
      <button
        ref={triggerRef}
        type="button"
        className="dropdown-trigger device-secondary automation-select"
        aria-label="已有话题"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled || loading}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {triggerLabel}
        <Icon name="down" className="dropdown-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="menu"
            aria-label="已有话题"
            className="dropdown-panel automation-cascade-panel"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            {active === null ? (
              groups.map((group) => (
                <button
                  key={group.id || 'temporary'}
                  type="button"
                  role="menuitem"
                  className="dropdown-item"
                  onClick={() => setGroupId(group.id)}
                >
                  <span className="dropdown-item-copy">
                    {group.name}
                    <small>{group.threads.length} 个话题</small>
                  </span>
                  <Icon name="chevron" className="i-sm dropdown-chevron" />
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  className="dropdown-item automation-cascade-back"
                  onClick={() => setGroupId(null)}
                >
                  <Icon name="back" className="i-sm" />
                  <span className="dropdown-item-copy">{active.name}</span>
                </button>
                <div className="automation-cascade-list">
                  {active.threads.length === 0 ? (
                    <div className="dropdown-section">该空间暂无话题</div>
                  ) : (
                    active.threads.map((thread) => (
                      <button
                        key={thread.threadId}
                        type="button"
                        role="menuitem"
                        className="dropdown-item"
                        onClick={() => {
                          onSelect(thread.threadId);
                          close();
                        }}
                      >
                        <span className="dropdown-item-copy">{thread.title || '未命名话题'}</span>
                        {thread.threadId === value && (
                          <Icon name="check" className="i-sm dropdown-check selected" />
                        )}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>,
          triggerRef.current?.closest('dialog') ?? document.body,
        )}
    </div>
  );
}

export function AutomationEditor({
  clients,
  actions,
  automation,
  session,
  revision = 0,
  onClose,
  onSaved,
}: {
  clients: KairosClients;
  actions: ActionExecutorView;
  automation: Automation | null;
  session: string;
  revision?: number;
  onClose: () => void;
  onSaved: (automation: Automation) => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<AutomationFormValue>(() =>
    automation ? automationFormValue(automation) : newAutomationForm(),
  );
  const [threads, setThreads] = useState<Thread[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [timeZoneSearch, setTimeZoneSearch] = useState('');
  const timeZoneOptions = useMemo(() => automationTimeZoneOptions(form.timeZone), [form.timeZone]);
  const [error, setError] = useState<string | null>(null);
  const actionKey = automation
    ? `automation:update:${automation.scheduleId}`
    : `automation:create:${session}`;
  const pendingUnknown = actions.failures.some(
    (failure) => failure.key === actionKey && failure.outcome === 'unknown',
  );
  const unknownRevision = useRef<number | null>(null);

  useEffect(() => {
    if (pendingUnknown) {
      unknownRevision.current = revision;
      return;
    }
    if (unknownRevision.current !== null && unknownRevision.current !== revision) {
      unknownRevision.current = null;
      onClose();
    }
  }, [onClose, pendingUnknown, revision]);

  useEffect(() => {
    if (form.targetKind !== AutomationTargetKind.EXISTING_THREAD) return;
    const controller = new AbortController();
    setThreadsLoading(true);
    setThreadsError(null);
    void Promise.all([
      listOrdinaryThreads(clients, controller.signal),
      clients.workspaces.listWorkspaces({}, { signal: controller.signal }),
    ]).then(
      ([values, workspaceResponse]) => {
        if (!controller.signal.aborted) {
          setThreads(values);
          setWorkspaces(workspaceResponse.workspaces);
          setThreadsLoading(false);
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setThreadsError(formatClientError(cause));
          setThreadsLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [clients, form.targetKind]);

  function update(patch: Partial<AutomationFormValue>): void {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pendingUnknown || actions.busy) return;
    try {
      const definition = automationDefinitionPayload(form);
      const response = automation
        ? await actions.execute<UpdateAutomationResponse>(actionKey, 'updateAutomation', {
            ...definition,
            scheduleId: automation.scheduleId,
            expectedVersion: automation.version.toString(),
          })
        : await actions.execute<CreateAutomationResponse>(
            actionKey,
            'createAutomation',
            definition,
          );
      if (response?.automation) onSaved(requireAutomation(response.automation));
    } catch (cause) {
      setError(formatClientError(cause));
    }
  }

  const disabled = actions.busy || pendingUnknown;
  const targetOptions = [
    AutomationTargetKind.MAIN,
    AutomationTargetKind.EXISTING_THREAD,
    AutomationTargetKind.NEW_TASK,
    AutomationTargetKind.NEW_AUTOMATION_ONLY,
  ].map((kind) => ({ value: String(kind), label: automationTargetText(kind) }));

  return (
    <AppDialog
      wide
      title={automation ? '修改定时任务' : '新建定时任务'}
      subtitle="定时触发与立即执行共用同一份定义。"
      closeDisabled={actions.busy}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="device-secondary"
            disabled={actions.busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            form={formId}
            type="submit"
            className="device-primary"
            disabled={actions.busy || pendingUnknown}
          >
            {actions.busy ? '正在保存…' : automation ? '保存修改' : '创建定时任务'}
          </button>
        </>
      }
    >
      <form id={formId} className="automation-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={actions.busy || pendingUnknown}>
          <label>
            名称
            <input
              required
              maxLength={200}
              value={form.name}
              onChange={(event) => update({ name: event.currentTarget.value })}
              placeholder="例如：每日工作摘要"
            />
          </label>
          <label>
            每次执行的提示词
            <textarea
              required
              rows={5}
              maxLength={100000}
              value={form.prompt}
              onChange={(event) => update({ prompt: event.currentTarget.value })}
              placeholder="说明本次执行要完成的任务"
            />
          </label>
          <div className="automation-form-grid">
            <div className="automation-field">
              <span>重复</span>
              <Dropdown
                label="重复"
                trigger={
                  <>
                    {automationRepeatLabel(form.repeat)}
                    <Icon name="down" className="dropdown-chevron" />
                  </>
                }
                triggerClassName="device-secondary automation-select"
                value={form.repeat}
                items={
                  form.repeat === 'custom'
                    ? [
                        { value: 'custom', label: '自定义重复（保留现有规则）' },
                        ...automationRepeatOptions,
                      ]
                    : automationRepeatOptions
                }
                disabled={disabled}
                onSelect={(repeat) => update({ repeat })}
              />
            </div>
            {form.repeat === 'hourly' ? (
              <div className="automation-field">
                <span>时间</span>
                <Dropdown
                  label="时间"
                  trigger={
                    <>
                      每小时第 {form.hourlyMinute} 分钟
                      <Icon name="down" className="dropdown-chevron" />
                    </>
                  }
                  triggerClassName="device-secondary automation-select"
                  value={form.hourlyMinute}
                  items={Array.from({ length: 60 }, (_, minute) => ({
                    value: String(minute),
                    label: `第 ${minute} 分钟`,
                  }))}
                  disabled={disabled}
                  onSelect={(hourlyMinute) => update({ hourlyMinute })}
                />
              </div>
            ) : form.repeat === 'custom' ? (
              <div className="automation-field">
                <span>时间</span>
                <p className="automation-field-help">
                  保留现有复杂重复规则。选择其他重复方式可重新设置时间。
                </p>
              </div>
            ) : form.repeat === 'once' ? (
              <div className="automation-field">
                <span>时间</span>
                <span className="automation-time-fields">
                  <input
                    type="date"
                    required
                    aria-label="日期"
                    value={form.runAtLocal.split('T')[0] ?? ''}
                    disabled={disabled}
                    onChange={(event) =>
                      update({
                        runAtLocal: `${event.currentTarget.value}T${
                          form.runAtLocal.split('T')[1] ?? '09:00'
                        }`,
                      })
                    }
                  />
                  <AutomationTimeFields
                    value={form.runAtLocal.split('T')[1] ?? '09:00'}
                    disabled={disabled}
                    onChange={(time) =>
                      update({ runAtLocal: `${form.runAtLocal.split('T')[0] ?? ''}T${time}` })
                    }
                  />
                </span>
              </div>
            ) : (
              <div className="automation-field">
                <span>时间</span>
                <AutomationTimeFields
                  value={form.time}
                  disabled={disabled}
                  onChange={(time) => update({ time })}
                />
              </div>
            )}
            <div className="automation-field">
              <span>时区</span>
              <Dropdown
                label="时区"
                trigger={
                  <>
                    {automationTimeZoneLabel(form.timeZone)}
                    <Icon name="down" className="dropdown-chevron" />
                  </>
                }
                triggerClassName="device-secondary automation-select"
                panelClassName="automation-time-zone-menu"
                value={form.timeZone}
                header={
                  <input
                    type="search"
                    aria-label="搜索时区"
                    placeholder="搜索时区或城市"
                    value={timeZoneSearch}
                    onChange={(event) => setTimeZoneSearch(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(event.key))
                        event.stopPropagation();
                    }}
                  />
                }
                items={timeZoneOptions.filter((option) =>
                  option.label.toLowerCase().includes(timeZoneSearch.trim().toLowerCase()),
                )}
                disabled={disabled}
                onSelect={(timeZone) => {
                  update({ timeZone });
                  setTimeZoneSearch('');
                }}
              />
            </div>
          </div>
          {form.repeat === 'weekly' && (
            <fieldset className="automation-weekdays">
              <legend>星期</legend>
              <div>
                {automationWeekdays.map((day) => (
                  <label key={day.value}>
                    <input
                      type="checkbox"
                      checked={form.weekdays.includes(day.value)}
                      onChange={(event) =>
                        update({
                          weekdays: event.currentTarget.checked
                            ? [...form.weekdays, day.value]
                            : form.weekdays.filter((value) => value !== day.value),
                        })
                      }
                    />
                    {day.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {form.repeat === 'monthly' && (
            <div className="automation-field">
              <span>日期</span>
              <Dropdown
                label="日期"
                trigger={
                  <>
                    每月 {form.monthDay} 日<Icon name="down" className="dropdown-chevron" />
                  </>
                }
                triggerClassName="device-secondary automation-select"
                value={form.monthDay}
                items={Array.from({ length: 31 }, (_, day) => ({
                  value: String(day + 1),
                  label: `${day + 1} 日`,
                }))}
                disabled={disabled}
                onSelect={(monthDay) => update({ monthDay })}
              />
              <span className="automation-field-help">当月没有所选日期时跳过该月。</span>
            </div>
          )}
          <div className="automation-field">
            <span>触发话题</span>
            <Dropdown
              label="触发话题"
              trigger={
                <>
                  {automationTargetText(form.targetKind)}
                  <Icon name="down" className="dropdown-chevron" />
                </>
              }
              triggerClassName="device-secondary automation-select"
              value={String(form.targetKind)}
              items={targetOptions}
              disabled={disabled}
              onSelect={(value) => {
                const targetKind = [
                  AutomationTargetKind.MAIN,
                  AutomationTargetKind.EXISTING_THREAD,
                  AutomationTargetKind.NEW_TASK,
                  AutomationTargetKind.NEW_AUTOMATION_ONLY,
                ].find((kind) => String(kind) === value);
                if (targetKind !== undefined) update({ targetKind, targetThreadId: '' });
              }}
            />
            {form.targetKind === AutomationTargetKind.NEW_AUTOMATION_ONLY && (
              <span className="automation-field-help">
                一次性对话只从该任务的执行历史进入，不进入最近话题和全部对话。
              </span>
            )}
          </div>
          {form.targetKind === AutomationTargetKind.EXISTING_THREAD && (
            <div className="automation-field">
              <span>已有话题</span>
              <WorkspaceThreadCascade
                threads={threads}
                workspaces={workspaces}
                value={form.targetThreadId}
                loading={threadsLoading}
                disabled={disabled}
                onSelect={(targetThreadId) => update({ targetThreadId })}
              />
              {threadsError && (
                <span className="automation-form-error" role="alert">
                  {threadsError}
                </span>
              )}
            </div>
          )}
          <label className="automation-enabled-field">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => update({ enabled: event.currentTarget.checked })}
            />
            保存后启用定时规则
          </label>
        </fieldset>
        {pendingUnknown && (
          <p className="automation-form-error" role="alert">
            保存结果未知。请使用页面上方的原操作重试入口，确认前不能修改参数。
          </p>
        )}
        {error && (
          <p className="automation-form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </AppDialog>
  );
}

function currentTarget(automation: Automation, mainThreadId: string): string | null {
  if (automation.target?.kind === AutomationTargetKind.MAIN) return mainThreadId;
  if (automation.target?.kind === AutomationTargetKind.EXISTING_THREAD) {
    return automation.target.threadId ?? null;
  }
  return null;
}

function actionUnavailable(actions: ActionExecutorView, key: string): boolean {
  return (
    actions.busy ||
    actions.failures.some((failure) => failure.key === key && failure.outcome === 'unknown')
  );
}

function mergeFires(current: AutomationFire[], incoming: AutomationFire[]): AutomationFire[] {
  const values = new Map(current.map((fire) => [fire.fireId, fire]));
  for (const fire of incoming) values.set(fire.fireId, fire);
  return [...values.values()].sort((left, right) =>
    left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0,
  );
}
