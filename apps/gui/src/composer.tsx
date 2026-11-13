import { InputMode } from '@kairos/contracts';
import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { formatAttachmentSize } from './attachments.js';
import { composerInputId, type DraftAttachment, type MessageDraft } from './drafts.js';
import { Dropdown, dropdownFocusIndex } from './dropdown.js';
import { Icon } from './icon.js';
import { randomId } from './random.js';

const slashCommands = [
  { name: '/reload', description: '重载提示词与 Skill' },
  { name: '/compact', description: '压缩当前对话上下文' },
  { name: '/new', description: '清空主对话上下文' },
] as const;

interface ComposerKeyboardEvent {
  key: string;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export type ComposerEnterAction = 'send' | 'newline' | 'ignore';

export function composerEnterAction(event: ComposerKeyboardEvent): ComposerEnterAction {
  if (event.key !== 'Enter' || event.isComposing || event.repeat) return 'ignore';
  return event.shiftKey ? 'newline' : 'send';
}

export function composerSlashCommandAction(
  event: ComposerKeyboardEvent,
  current: number,
  count: number,
): number | 'select' | null {
  if (event.isComposing || event.repeat || count === 0) return null;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    return dropdownFocusIndex(event.key, current, count);
  }
  return event.key === 'Enter' && !event.shiftKey ? 'select' : null;
}

export function slashCommandCandidates(text: string) {
  const input = text.trimStart();
  if (!input.startsWith('/')) return [];
  const query = input.slice(1);
  const matches = slashCommands.filter((command) => command.name.slice(1).includes(query));
  return matches.length === 1 && matches[0]?.name === input ? [] : matches;
}

export function addComposerClipboardFiles(
  files: readonly File[],
  onAddFiles: (files: File[], source: 'clipboard') => void,
): boolean {
  if (files.length === 0) return false;
  onAddFiles(
    files.map((file) => {
      if (file.name) return file;
      const extension =
        file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'txt';
      return new File([file], `pasted-${randomId()}.${extension}`, {
        type: file.type,
        lastModified: file.lastModified,
      });
    }),
    'clipboard',
  );
  return true;
}

export function Composer({
  draft,
  busy,
  unavailable,
  composerOwner,
  threadId,
  running = false,
  stopping = false,
  placeholder = '发送消息…',
  onChange,
  onSend,
  onStop,
  onAddFiles = () => {},
  onRemoveAttachment = () => {},
  onRetryAttachment = () => {},
  onReselectAttachment = () => {},
}: {
  draft: MessageDraft;
  busy: boolean;
  unavailable: boolean;
  composerOwner: string;
  threadId: string;
  running?: boolean;
  stopping?: boolean;
  placeholder?: string;
  onChange: (draft: MessageDraft) => void;
  onSend: (mode: InputMode) => Promise<void>;
  onStop?: (() => Promise<void>) | undefined;
  onAddFiles?: (files: File[], source?: 'clipboard') => void;
  onRemoveAttachment?: (attachment: DraftAttachment) => void;
  onRetryAttachment?: (attachment: DraftAttachment) => void;
  onReselectAttachment?: (attachment: DraftAttachment, file: File) => void;
}) {
  const attachments = draft.attachments ?? [];
  const attachmentsReady = attachments.every(
    (attachment) => attachment.status === 'ready' && attachment.metadata !== undefined,
  );
  const hasContent = Boolean(draft.text.trim()) || attachments.length > 0;
  const disabled = busy || unavailable || !attachmentsReady || !hasContent;
  const inputId = composerInputId({ composerOwner, threadId, draftId: draft.id });
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const isCommand = draft.text.trimStart().startsWith('/');
  const commandCandidates = slashCommandCandidates(draft.text);
  const commandListId = `${inputId}-slash-commands`;
  const [commandIndex, setCommandIndex] = useState(0);
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, commandCandidates.length - 1));
  useLayoutEffect(() => {
    const area = textarea.current;
    if (!area) return;
    area.style.height = draft.text ? 'auto' : '56px';
    area.style.height = `${Math.min(144, Math.max(56, area.scrollHeight))}px`;
  }, [draft.text]);
  function submit(mode = InputMode.FOLLOW_UP) {
    if (!disabled) void onSend(mode);
  }
  function selectSlashCommand(name: string) {
    onChange({ ...draft, text: name });
    textarea.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const keyboardEvent = {
      key: event.key,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
    };
    const commandAction = composerSlashCommandAction(
      keyboardEvent,
      activeCommandIndex,
      commandCandidates.length,
    );
    if (commandAction !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (commandAction === 'select') {
        const command = commandCandidates[activeCommandIndex];
        if (command) selectSlashCommand(command.name);
      } else {
        setCommandIndex(commandAction);
      }
      return;
    }
    if (composerEnterAction(keyboardEvent) !== 'send') return;
    event.preventDefault();
    submit((event.metaKey || event.ctrlKey) && !isCommand ? InputMode.STEER : InputMode.FOLLOW_UP);
  }
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (addComposerClipboardFiles(Array.from(event.clipboardData.files), onAddFiles)) {
      event.preventDefault();
    }
  }
  return (
    <form
      className={`composer${isCommand ? ' is-command' : ''}`}
      data-composer-owner={composerOwner}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {attachments.length > 0 && (
        <fieldset className="attachments" aria-label="草稿附件">
          {attachments.map((attachment) => (
            <DraftAttachmentChip
              key={attachment.localId}
              attachment={attachment}
              busy={busy}
              inputId={inputId}
              onRemove={onRemoveAttachment}
              onRetry={onRetryAttachment}
              onReselect={onReselectAttachment}
            />
          ))}
        </fieldset>
      )}
      <label className="sr-only" htmlFor={inputId}>
        消息
      </label>
      {commandCandidates.length > 0 && (
        <div
          id={commandListId}
          className="dropdown-panel composer-menu slash-command-menu"
          role="listbox"
          aria-label="斜杠命令"
        >
          {commandCandidates.map((command, index) => (
            <button
              id={`${commandListId}-${command.name.slice(1)}`}
              type="button"
              className="dropdown-item"
              role="option"
              aria-selected={index === activeCommandIndex}
              aria-label={`${command.name} ${command.description}`}
              tabIndex={-1}
              key={command.name}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCommandIndex(index)}
              onClick={() => selectSlashCommand(command.name)}
            >
              <span className="dropdown-item-copy">
                <code>{command.name}</code>
                <small>{command.description}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textarea}
        id={inputId}
        value={draft.text}
        onChange={(event) => {
          setCommandIndex(0);
          onChange({ ...draft, text: event.target.value });
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={1}
        aria-autocomplete="list"
        aria-controls={commandCandidates.length > 0 ? commandListId : undefined}
        aria-activedescendant={
          commandCandidates.length > 0
            ? `${commandListId}-${commandCandidates[activeCommandIndex]?.name.slice(1)}`
            : undefined
        }
      />
      <div className="composer-bottom">
        <div className="composer-tools">
          <Dropdown
            label="添加附件或命令"
            triggerClassName="icon-button composer-add"
            panelClassName="composer-menu"
            placement="top"
            trigger={<Icon name="plus" />}
            disabled={unavailable}
            items={[
              { value: 'upload' as const, label: '上传附件', icon: 'clip' as const },
              ...slashCommands.map((command) => ({
                value: command.name,
                label: <code>{command.name}</code>,
                description: command.description,
                section: '命令',
              })),
            ]}
            onSelect={(value) => {
              if (value === 'upload') {
                fileInput.current?.click();
              } else {
                selectSlashCommand(value);
              }
            }}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="上传附件"
            accept="text/plain,image/png,image/jpeg,.txt,.png,.jpg,.jpeg"
            onChange={(event) => {
              onAddFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </div>
        <div className="composer-submit">
          {running ? (
            <button
              type="button"
              className="send-btn stop-btn"
              aria-label={stopping ? '正在停止' : '停止执行'}
              title={stopping ? '停止请求已接受，等待执行结束' : '停止执行'}
              disabled={busy || stopping || unavailable}
              onClick={() => void onStop?.()}
            >
              <Icon
                name={stopping ? 'spinner' : 'stop'}
                className={stopping ? 'spinning i-sm' : 'i-sm'}
              />
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              aria-label={isCommand ? '执行命令' : '发送消息'}
              disabled={disabled}
            >
              <Icon name={busy ? 'spinner' : 'up'} className={busy ? 'spinning' : ''} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function DraftAttachmentChip({
  attachment,
  busy,
  inputId,
  onRemove,
  onRetry,
  onReselect,
}: {
  attachment: DraftAttachment;
  busy: boolean;
  inputId: string;
  onRemove: (attachment: DraftAttachment) => void;
  onRetry: (attachment: DraftAttachment) => void;
  onReselect: (attachment: DraftAttachment, file: File) => void;
}) {
  const label = attachmentStatusLabel(attachment);
  const pending = attachment.status === 'reading' || attachment.status === 'uploading';
  const reselect =
    attachment.status === 'needs-reselection' ||
    (attachment.status === 'error' && !attachment.file);
  const failed = attachment.status === 'error' || attachment.status === 'unknown' || reselect;
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`attachment${failed ? ' attachment-failed' : ''}`}
      data-attachment-status={attachment.status}
      title={`${attachment.fileName} · ${formatAttachmentSize(attachment.sizeBytes)} · ${attachment.error ?? label}`}
    >
      <Icon
        name={pending ? 'spinner' : failed ? 'alert' : 'files'}
        className={`i-sm${pending ? ' spinning' : ''}`}
      />
      <span className="attachment-name">{attachment.fileName}</span>
      <span className="sr-only" role="status">
        {label}
        {attachment.error}
      </span>
      {reselect ? (
        <>
          <button
            type="button"
            className="attachment-retry"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            重新选择
          </button>
          <input
            ref={input}
            hidden
            type="file"
            id={`${inputId}:reselect:${attachment.localId}`}
            accept="text/plain,image/png,image/jpeg,.txt,.png,.jpg,.jpeg"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onReselect(attachment, file);
              event.target.value = '';
            }}
          />
        </>
      ) : (
        failed && (
          <button
            type="button"
            className="icon-button"
            aria-label="重试上传附件"
            disabled={busy}
            onClick={() => onRetry(attachment)}
          >
            <Icon name="retry" className="i-sm" />
          </button>
        )
      )}
      <button
        type="button"
        className="icon-button attachment-remove"
        aria-label={`移除附件 ${attachment.fileName}`}
        disabled={
          busy ||
          attachment.status === 'uploading' ||
          attachment.status === 'unknown' ||
          attachment.status === 'needs-reselection'
        }
        onClick={() => onRemove(attachment)}
      >
        <Icon name="close" className="i-sm" />
      </button>
    </div>
  );
}

function attachmentStatusLabel(attachment: DraftAttachment): string {
  switch (attachment.status) {
    case 'reading':
      return '正在读取并校验文件';
    case 'uploading':
      return '正在上传附件';
    case 'ready':
      return '附件已上传';
    case 'unknown':
      return '上传结果未知，重试将核对原操作';
    case 'needs-reselection':
      return '请重新选择同一文件以核对上传结果';
    case 'deleting':
      return '正在移除附件';
    case 'error':
      return '附件上传失败';
  }
}
