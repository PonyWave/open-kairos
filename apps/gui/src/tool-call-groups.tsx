import type { Message, ToolCall } from '@kairos/contracts';
import { useState } from 'react';
import type { KairosClients } from './client.js';
import { ToolResultCard } from './conversation.js';
import { Icon } from './icon.js';
import { ThinkingBlock } from './thinking-block.js';
import { isThinkingBlockExpanded, type ThinkingExpansionChoices } from './thinking-expansion.js';
import {
  type ToolGroupOperation,
  type ToolOutcome,
  toolGroupState,
  toolOperationState,
  toolStateLabel,
} from './tool-group-projection.js';

export type ToolExpansionChoices = Readonly<Record<string, boolean>>;
export type ToolExpansionChange = (operationId: string, expanded: boolean) => void;

import type { ToolProgressState } from './thread-projection.js';

type ToolProps = {
  message: Message;
  calls: readonly ToolCall[];
  progressByCall?: ReadonlyMap<string, ToolProgressState> | undefined;
  operations?: readonly ToolGroupOperation[] | undefined;
  outcomes: ReadonlyMap<string, ToolOutcome>;
  streaming: boolean;
  clients: KairosClients;
  choices: ToolExpansionChoices;
  onExpandedChange: ToolExpansionChange;
  thinkingExpansionChoices?: ThinkingExpansionChoices | undefined;
  onThinkingExpansionChange?:
    | ((messageId: string, blockIndex: number, expanded: boolean) => void)
    | undefined;
};

export function ToolOperationGroup(props: ToolProps) {
  const { message, calls, outcomes, streaming, choices, onExpandedChange } = props;
  const operations =
    props.operations ??
    calls.map((call) => ({
      kind: 'call' as const,
      id: call.toolCallId,
      messageId: message.messageId,
      call,
    }));
  const firstOperation = operations[0];
  if (!firstOperation) return null;
  if (operations.length === 1) {
    if (firstOperation.kind === 'call') {
      return (
        <ToolOperationLine
          {...props}
          messageId={firstOperation.messageId || message.messageId}
          call={firstOperation.call}
        />
      );
    }
    return (
      <ThinkingBlock
        text={firstOperation.text}
        active={firstOperation.active}
        expanded={isThinkingBlockExpanded(
          props.thinkingExpansionChoices ?? {},
          firstOperation.messageId,
          firstOperation.blockIndex,
        )}
        onExpandedChange={(next) =>
          props.onThinkingExpansionChange?.(
            firstOperation.messageId,
            firstOperation.blockIndex,
            next,
          )
        }
      />
    );
  }
  const thinking = operations.filter((operation) => operation.kind === 'thinking');
  const mixed = thinking.length > 0;
  const operationId =
    firstOperation.kind === 'thinking'
      ? `group:${firstOperation.messageId || message.messageId}:${firstOperation.id}`
      : `group:${firstOperation.messageId || message.messageId}:${firstOperation.call.toolCallId}`;
  const activeThinking = thinking.some((operation) => operation.active);
  const groupStreaming = streaming || activeThinking;
  const callGroupState = toolGroupState(calls, outcomes, groupStreaming);
  const groupState = callGroupState === 'succeeded' && activeThinking ? 'running' : callGroupState;
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
  const entries = [...counts];
  const summary = entries.map(([name, count]) => `${name} ×${count}`).join('，');
  const mixedSummary = [
    `Thinking ×${thinking.length}`,
    ...entries.map(([name, count]) => `${name} ×${count}`),
  ].join('，');
  const descriptions = entries.flatMap(([name]) => {
    const call = calls.find((candidate) => candidate.toolName === name);
    const description = call ? toolDescription(call) : '';
    return description ? [`${name} ${description}`] : [];
  });
  const fullMixedSummary = [mixedSummary, ...descriptions].join('，');
  const chipLimit = mixed ? 2 : 3;
  const attention = groupState !== 'succeeded';
  const groupExpanded = choices[operationId] === true;
  return (
    <details
      className={`tool-operation tool-group ${groupState}`}
      data-operation={operationId}
      open={groupExpanded}
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        if (expanded !== groupExpanded) {
          onExpandedChange(operationId, expanded);
        }
      }}
    >
      <summary
        aria-label={
          mixed
            ? `${fullMixedSummary}，${toolStateLabel(groupState, true)}`
            : `${summary}，共 ${calls.length} 次调用，${toolStateLabel(groupState, true)}`
        }
        title={mixed ? fullMixedSummary : summary}
      >
        <span className="tool-group-chips">
          {mixed && (
            <span className="tool-chip thinking-chip">
              <code>Thinking</code>
              <span className="tool-chip-count">×{thinking.length}</span>
            </span>
          )}
          {entries.slice(0, chipLimit).map(([name, count]) => (
            <span className="tool-chip" key={name}>
              <code>{name}</code>
              <span className="tool-chip-count">×{count}</span>
            </span>
          ))}
        </span>
        {entries.length > chipLimit && (
          <span className="tool-group-more">等 {entries.length} 个工具</span>
        )}
        {mixed && descriptions.length > 0 && (
          <span className="tool-operation-title tool-group-description">
            {descriptions.join('，')}
          </span>
        )}
        {attention && (
          <span
            className={`tool-group-status ${groupState}`}
            title={toolStateLabel(groupState, true)}
          >
            <Icon
              name={groupState === 'running' ? 'spinner' : 'alert'}
              className={`i-sm${groupState === 'running' ? ' spinning' : ''}`}
            />
          </span>
        )}
        <Icon name="chevron" className="tool-group-chevron i-sm" />
      </summary>
      <div className="tool-group-items">
        {operations.map((operation) =>
          operation.kind === 'thinking' ? (
            <ThinkingBlock
              key={`${operation.messageId}:${operation.id}`}
              text={operation.text}
              active={operation.active}
              expanded={isThinkingBlockExpanded(
                props.thinkingExpansionChoices ?? {},
                operation.messageId,
                operation.blockIndex,
              )}
              onExpandedChange={(next) =>
                props.onThinkingExpansionChange?.(operation.messageId, operation.blockIndex, next)
              }
            />
          ) : (
            <ToolOperationLine
              {...props}
              key={`${operation.messageId}:${operation.call.toolCallId}`}
              messageId={operation.messageId || message.messageId}
              call={operation.call}
              streaming={groupStreaming}
            />
          ),
        )}
      </div>
    </details>
  );
}

function toolDescription(call: ToolCall): string {
  try {
    const args: unknown = JSON.parse(call.argumentsJson);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    for (const field of ['description', 'command', 'path', 'sql']) {
      const value: unknown = Reflect.get(args, field);
      if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').slice(0, 160);
    }
  } catch {
    return '';
  }
  return '';
}

function OAuthProgressCard({
  authorization,
}: {
  authorization: NonNullable<ToolProgressState['authorization']>;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="oauth-progress">
      <p className="oauth-progress-title">
        <Icon name="spinner" className="i-sm spinning" />
        MCP server {authorization.serverName} 需要授权
      </p>
      <div className="oauth-progress-link">
        <a href={authorization.authorizationUrl} target="_blank" rel="noopener noreferrer">
          {authorization.authorizationUrl}
        </a>
        <button
          type="button"
          className="device-secondary"
          aria-label="复制授权链接"
          aria-live="polite"
          onClick={() => {
            void navigator.clipboard.writeText(authorization.authorizationUrl).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} className="i-sm" />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="oauth-progress-expiry">
        有效期至 {new Date(authorization.expiresAt).toLocaleString()}
      </p>
    </div>
  );
}

function ToolOperationLine({
  message,
  messageId = message.messageId,
  call,
  outcomes,
  streaming,
  clients,
  choices,
  onExpandedChange,
  progressByCall,
}: ToolProps & { call: ToolCall; messageId?: string }) {
  const outcome = outcomes.get(call.toolCallId);
  const progress = progressByCall?.get(call.toolCallId);
  const state = toolOperationState(call, outcome, streaming);
  const operationId = `call:${messageId}:${call.toolCallId}`;
  const icon =
    call.toolName === 'bash' || call.toolName === 'device_bash'
      ? 'code'
      : call.toolName === 'recall'
        ? 'memory'
        : 'files';
  const description = toolDescription(call);
  return (
    <details
      className={`tool-operation ${state}`}
      data-operation={operationId}
      data-tool-call-id={call.toolCallId}
      open={choices[operationId] === true || progress?.authorization !== undefined}
      onToggle={(event) => onExpandedChange(operationId, event.currentTarget.open)}
    >
      <summary>
        <Icon name={icon} className="i-sm" />
        <code>{call.toolName}</code>
        <span className="tool-operation-title">{description}</span>
        <span className="tool-operation-state">
          {state === 'running' && <Icon name="spinner" className="i-sm spinning" />}
          {toolStateLabel(state)}
        </span>
        <Icon name="chevron" className="i-sm" />
      </summary>
      <div className="tool-operation-detail">
        <div className="tool-detail-heading">参数</div>
        <pre>{call.argumentsJson}</pre>
        {outcome ? (
          <ToolResultCard message={outcome.message} clients={clients} />
        ) : progress?.authorization !== undefined ? (
          <OAuthProgressCard authorization={progress.authorization} />
        ) : progress !== undefined ? (
          <p className="tool-progress">{progress.text}</p>
        ) : (
          <p className="tool-waiting">
            {state === 'running' ? '等待工具返回结果' : '工具结果待核对'}
          </p>
        )}
      </div>
    </details>
  );
}
