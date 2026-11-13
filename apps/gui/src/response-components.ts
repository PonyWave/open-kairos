import { type Input, type Run, RunStatus } from '@kairos/contracts';
import { createElement } from 'react';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { MessageAvatar } from './message-avatar.js';

export function EditedMarker({ revisionId }: { revisionId: string | undefined }) {
  return revisionId ? createElement('span', { className: 'edited-marker' }, '（已编辑）') : null;
}

export function RunOutcomeCard({
  run,
  busy,
  onContinue,
}: {
  run: Run;
  busy: boolean;
  onContinue: (run: Run) => Promise<unknown>;
}) {
  const continuable =
    run.status === RunStatus.FAILED ||
    run.status === RunStatus.CANCELLED ||
    run.status === RunStatus.INTERRUPTED;
  if (!continuable) return null;
  if (run.status === RunStatus.CANCELLED)
    return createElement(
      'div',
      { className: 'stopped-notice' },
      createElement('span', null, '已停止'),
      createElement(
        'button',
        {
          type: 'button',
          className: 'text-button',
          disabled: busy,
          onClick: () => void onContinue(run),
        },
        '继续',
      ),
    );
  return createElement(
    'div',
    { className: 'run-failure' },
    createElement(FailureNotice, {
      message: run.error?.message ?? '执行中断，核对状态后可以重试。',
      busy,
      onRetry: () => void onContinue(run),
    }),
  );
}

export function PendingAgentCard({
  input,
  compact,
  mainAgent = true,
}: {
  input: Input | Run;
  compact: boolean;
  mainAgent?: boolean;
}) {
  const pendingId = 'inputId' in input ? input.inputId : input.runId;
  return createElement(
    'article',
    {
      className: 'message assistant pending-agent-message',
      'data-pending-input-id': pendingId,
    },
    createElement(MessageAvatar, {
      label: 'Kairos',
      timestamp: input.createdAt,
      threadId: input.threadId,
      mainAgent,
    }),
    createElement(
      'div',
      { className: 'message-content' },
      compact
        ? createElement(
            'div',
            {
              className: 'sent-message-bubble pending-agent-bubble',
              role: 'status',
              'aria-label': 'Agent 正在输入',
            },
            [0, 1, 2].map((index) =>
              createElement('span', { key: index, 'aria-hidden': true }, '.'),
            ),
          )
        : createElement(
            'span',
            {
              className: 'pending-agent-spinner',
              role: 'status',
              'aria-label': 'Agent 正在输入',
            },
            createElement(Icon, { name: 'spinner', className: 'spinning' }),
          ),
    ),
  );
}
