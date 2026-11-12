import { RunStatus, type SubagentCallView, type ToolCall } from '@kairos/contracts';
import { EntityMark } from './entity-mark.js';
import { Icon } from './icon.js';

export function SubagentCard({
  call,
  view,
  onOpen,
}: {
  call: ToolCall;
  view: SubagentCallView | undefined;
  onOpen: (view: SubagentCallView) => void;
}) {
  let task = '独立任务';
  try {
    const args: unknown = JSON.parse(call.argumentsJson);
    if (args && typeof args === 'object' && typeof Reflect.get(args, 'task') === 'string')
      task = Reflect.get(args, 'task');
  } catch {
    /* Incomplete streamed arguments have no task preview yet. */
  }
  const status = view?.status;
  const running =
    status === undefined ||
    status === RunStatus.RUNNING ||
    status === RunStatus.QUEUED ||
    status === RunStatus.WAITING;
  const label =
    status === undefined
      ? '正在创建'
      : status === RunStatus.COMPLETED
        ? '已完成'
        : status === RunStatus.FAILED
          ? '失败'
          : status === RunStatus.CANCELLED
            ? '已停止'
            : status === RunStatus.INTERRUPTED
              ? '已中断'
              : '执行中';
  return (
    <button
      type="button"
      className="subagent-card"
      disabled={!view}
      onClick={() => view && onOpen(view)}
      aria-label={`查看子代理：${view?.task || task}`}
    >
      <EntityMark subagent />
      <span className="subagent-card-copy">
        <strong>子代理</strong>
        <span>{view?.task || task}</span>
      </span>
      <span className="subagent-card-status">
        {running && <Icon name="spinner" className="i-sm spinning" />}
        {label}
      </span>
      <Icon name="chevron" className="i-sm" />
    </button>
  );
}
