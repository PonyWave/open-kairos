import type { Thread } from '@kairos/contracts';
import { useEffect, useRef, useState } from 'react';
import { EntityMark } from './entity-mark.js';
import { Icon } from './icon.js';

export function TitleEditor({
  title,
  busy,
  onSave,
  onCancel,
}: {
  title: string;
  busy: boolean;
  onSave: (title: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function save(): Promise<void> {
    const nextTitle = value.trim();
    if (!nextTitle || saving.current || cancelled.current || busy) return;
    saving.current = true;
    try {
      await onSave(nextTitle);
    } finally {
      saving.current = false;
    }
  }

  function cancel(): void {
    cancelled.current = true;
    onCancel();
  }

  return (
    <form
      className="title-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        ref={input}
        aria-label="编辑话题名称"
        value={value}
        disabled={busy}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value.trim()) {
            void save();
          } else if (!saving.current && !busy) {
            cancel();
          }
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      />
    </form>
  );
}

export function RecentTopicItem({
  thread,
  current,
  busy,
  onOpen,
  onRename,
}: {
  thread: Thread;
  current: boolean;
  busy: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={`recent-item${current ? ' current' : ''}`}>
      <EntityMark threadId={thread.threadId} />
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
          className="recent-open"
          title={`${thread.title} · 双击编辑名称`}
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
        >
          {thread.title || '未命名话题'}
        </button>
      )}
    </div>
  );
}

export function TopicTitleActions({
  onLocate,
  onEdit,
}: {
  onLocate?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
}) {
  return (
    <span className="title-actions">
      {onLocate && (
        <button
          type="button"
          className="icon-button title-icon"
          title="定位到原始消息"
          aria-label="定位到原始消息"
          onClick={onLocate}
        >
          <Icon name="pin" />
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          className="icon-button title-icon"
          title="编辑话题名称"
          aria-label="编辑话题名称"
          onClick={onEdit}
        >
          <Icon name="edit" />
        </button>
      )}
    </span>
  );
}
