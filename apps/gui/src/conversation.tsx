import {
  type Input,
  InputStatus,
  type Message,
  MessageSource,
  type Recap,
} from '@kairos/contracts';
import { useState } from 'react';
import type { KairosClients } from './client.js';
import { Icon } from './icon.js';
import { parseToolContent } from './tool-content.js';
import { toolOperationState, toolStateLabel } from './tool-group-projection.js';

export { MessageCard } from './message-card.js';
export { RunOutcomeCard } from './response-components.js';

export function ToolResultCard({
  message,
  showStatus = false,
}: {
  message: Message;
  clients: KairosClients;
  showStatus?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const result = parseToolContent(message.content);
  const state = showStatus ? toolOperationState(message, { message, result }, false) : null;
  const longOutput = result.output.length > 4000;
  const output = longOutput && !expanded ? result.output.slice(0, 2000) : result.output;
  return (
    <div className="tool-result">
      <div className="tool-detail-heading">
        返回{state === null ? '' : ` · ${toolStateLabel(state)}`}
      </div>
      <pre className="tool-output">{output}</pre>
      {longOutput && (
        <button
          type="button"
          className="text-button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起内容' : '展开完整预览'}
        </button>
      )}
      <div className="notice-list">
        {result.truncated && <p>输出较长，当前仅展示预览。</p>}
        {result.outputComplete === false && <p>输出不完整。</p>}
        {result.resultUnknown && <p>执行结果待核对。</p>}
        {result.deviceOffline && <p>设备已离线。</p>}
      </div>
    </div>
  );
}

export function RecapLine({ recap }: { recap: Recap }) {
  return (
    <div className="tool-operation recap-line" data-recap-id={recap.recapId}>
      <Icon name="memory" className="i-sm recap-icon" />
      <span className="recap-content">Recap：{recap.content}</span>
    </div>
  );
}

export function projectQueuedInputs(inputs: readonly Input[]): Input[] {
  return inputs
    .filter(
      (input) =>
        input.status === InputStatus.QUEUED &&
        input.source !== MessageSource.THREAD_RESPONSE &&
        input.source !== MessageSource.SUBAGENT_RESPONSE &&
        input.source !== MessageSource.AUTOMATION,
    )
    .sort((left, right) => {
      if (left.position < right.position) return -1;
      if (left.position > right.position) return 1;
      return left.inputId < right.inputId ? -1 : 1;
    });
}
