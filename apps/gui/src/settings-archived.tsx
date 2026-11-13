import type { Thread } from '@kairos/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { KairosClients } from './client.js';
import { EntityMark } from './entity-mark.js';
import { formatClientError } from './errors.js';
import { Icon } from './icon.js';
import { randomId } from './random.js';
import { formatAbsoluteDateTime, timestampDate } from './time-format.js';

const pageSize = 50;

export function ArchivedSettingsPanel({
  clients,
  onChanged,
}: {
  clients: KairosClients;
  onChanged?: (() => void) | undefined;
}) {
  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [nextSeq, setNextSeq] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(
    async (afterSeq: bigint, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const response = await clients.thread.listArchivedThreads({
          afterSeq,
          limit: pageSize,
        });
        setThreads((current) => (append ? [...current, ...response.threads] : response.threads));
        setNextSeq(response.hasMore ? (response.nextSeq ?? null) : null);
      } catch (cause) {
        if (!append) setThreads([]);
        setError(formatClientError(cause));
      } finally {
        setLoading(false);
      }
    },
    [clients],
  );
  useEffect(() => {
    void load(0n, false);
  }, [load]);

  async function restore(thread: Thread) {
    setBusyId(thread.threadId);
    setError(null);
    try {
      await clients.thread.restoreThread({
        clientActionId: randomId(),
        threadId: thread.threadId,
      });
      setThreads((current) => current.filter((value) => value.threadId !== thread.threadId));
      onChanged?.();
    } catch (cause) {
      setError(formatClientError(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(thread: Thread) {
    setBusyId(thread.threadId);
    setError(null);
    try {
      await clients.thread.deleteThread({
        clientActionId: randomId(),
        threadId: thread.threadId,
      });
      setThreads((current) => current.filter((value) => value.threadId !== thread.threadId));
      setConfirmingId(null);
    } catch (cause) {
      setError(formatClientError(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="settings-form settings-archived">
      <div className="settings-section-heading">
        <h2>已归档话题</h2>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {loading && threads.length === 0 ? (
        <p role="status" className="muted">
          正在加载已归档话题…
        </p>
      ) : threads.length === 0 && !error ? (
        <p className="empty">没有已归档的话题。</p>
      ) : (
        <ul className="settings-archived-list">
          {threads.map((thread) => {
            const archivedAt = timestampDate(thread.updatedAt);
            const confirming = confirmingId === thread.threadId;
            const busy = busyId === thread.threadId;
            return (
              <li key={thread.threadId} className="settings-archived-row">
                <EntityMark threadId={thread.threadId} className="settings-archived-mark" />
                <span className="settings-archived-title" title={thread.title}>
                  {thread.title || '未命名话题'}
                </span>
                <span className="settings-help settings-archived-time">
                  {archivedAt ? formatAbsoluteDateTime(archivedAt) : ''}
                </span>
                {confirming ? (
                  <span className="settings-archived-actions">
                    <button
                      type="button"
                      className="settings-text-button settings-danger"
                      disabled={busy}
                      onClick={() => void remove(thread)}
                    >
                      {busy ? '正在删除…' : '确认永久删除'}
                    </button>
                    <button
                      type="button"
                      className="settings-text-button"
                      disabled={busy}
                      onClick={() => setConfirmingId(null)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <span className="settings-archived-actions">
                    <button
                      type="button"
                      className="icon-button settings-archived-restore"
                      aria-label={`恢复 ${thread.title || '未命名话题'}`}
                      title="恢复话题"
                      disabled={busy}
                      onClick={() => void restore(thread)}
                    >
                      <Icon name="retry" className="i-sm" />
                    </button>
                    <button
                      type="button"
                      className="icon-button settings-archived-delete"
                      aria-label={`永久删除 ${thread.title || '未命名话题'}`}
                      title="永久删除"
                      disabled={busy}
                      onClick={() => setConfirmingId(thread.threadId)}
                    >
                      <Icon name="trash" className="i-sm" />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {nextSeq !== null && (
        <button
          type="button"
          className="device-secondary"
          disabled={loading}
          onClick={() => void load(nextSeq, true)}
        >
          {loading ? '正在加载…' : '加载更多'}
        </button>
      )}
    </div>
  );
}
