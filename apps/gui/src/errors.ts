import { Code, ConnectError } from '@connectrpc/connect';
import { ErrorCode, ErrorDetailSchema } from '@kairos/contracts';
import { ActionPayloadError } from './actions.js';

export type ActionFailureOutcome = 'not-executed' | 'terminal' | 'unknown';

const notExecutedBusinessErrors: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.VERSION_CONFLICT,
  ErrorCode.ACTION_CONFLICT,
  ErrorCode.DEVICE_OFFLINE,
  ErrorCode.RECAP_INVALID,
  ErrorCode.INPUT_TOO_LARGE,
  ErrorCode.PROTOCOL_INCOMPATIBLE,
  ErrorCode.INVALID_ARGUMENT,
  ErrorCode.NOT_FOUND,
  ErrorCode.FAILED_PRECONDITION,
  ErrorCode.SANDBOX_CAPACITY_EXHAUSTED,
  ErrorCode.SANDBOX_UNAVAILABLE,
]);

const notExecutedRpcCodes: ReadonlySet<Code> = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.FailedPrecondition,
  Code.Unauthenticated,
  Code.PermissionDenied,
  Code.Unimplemented,
  Code.OutOfRange,
]);

export function classifyActionFailure(error: unknown): ActionFailureOutcome {
  if (error instanceof ActionPayloadError) return 'not-executed';
  if (!(error instanceof ConnectError)) return 'unknown';
  const details = error.findDetails(ErrorDetailSchema);
  if (details.length > 0) {
    if (details.every((detail) => detail.terminal === true)) return 'terminal';
    return details.every((detail) => notExecutedBusinessErrors.has(detail.code))
      ? 'not-executed'
      : 'unknown';
  }
  return notExecutedRpcCodes.has(error.code) ? 'not-executed' : 'unknown';
}

const businessErrors: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.UNAUTHENTICATED]: '登录已失效，请重新登录。',
  [ErrorCode.PERMISSION_DENIED]: '当前账号没有执行该操作的权限。',
  [ErrorCode.VERSION_CONFLICT]: '数据版本已变化，请刷新后重试。',
  [ErrorCode.ACTION_CONFLICT]: '操作编号已用于不同参数，Server 已拒绝本次变更。',
  [ErrorCode.DEVICE_OFFLINE]: '设备离线，Server 中已保存的结果仍可查看。',
  [ErrorCode.OPERATION_UNKNOWN]: '操作结果未知，需要核对后才能重新执行。',
  [ErrorCode.RECAP_INVALID]: 'Recap 已失效，Server 保留原始 Context。',
  [ErrorCode.INPUT_TOO_LARGE]: '输入超过 Server 限制。',
  [ErrorCode.PROTOCOL_INCOMPATIBLE]: '客户端与 Server 的协议不兼容。',
  [ErrorCode.INVALID_ARGUMENT]: '请求参数无效。',
  [ErrorCode.NOT_FOUND]: '请求的记录不存在或已删除。',
  [ErrorCode.FAILED_PRECONDITION]: '当前状态不允许该操作。',
  [ErrorCode.INTERNAL]: 'Server 处理失败。',
  [ErrorCode.SANDBOX_CAPACITY_EXHAUSTED]: '当前 sandbox 均被占用，暂时无法启动环境，请稍后重试。',
  [ErrorCode.SANDBOX_UNAVAILABLE]: '平台环境暂时不可用，请核对状态后重试。',
};

export function formatClientError(error: unknown): string {
  if (error instanceof ConnectError) {
    for (const detail of error.findDetails(ErrorDetailSchema)) {
      const explanation = businessErrors[detail.code];
      if (detail.code === ErrorCode.SANDBOX_CAPACITY_EXHAUSTED && explanation) return explanation;
      if (detail.message) return `${explanation ?? '操作失败'} ${detail.message}`;
      if (explanation) return explanation;
    }
    if (error.code === Code.Unauthenticated) return '登录已失效，请重新登录。';
    if (error.code === Code.PermissionDenied) return '当前账号没有执行该操作的权限。';
    if (error.code === Code.AlreadyExists || error.code === Code.Aborted) {
      return '操作或数据版本冲突，请刷新后核对当前状态。';
    }
    if (error.code === Code.Unavailable || error.code === Code.DeadlineExceeded) {
      return 'Server 暂时不可用。若重试写操作，必须沿用原操作编号。';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isExpiredCursorError(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    (error.code === Code.OutOfRange || error.code === Code.DataLoss)
  );
}
