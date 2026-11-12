import { type Environment, EnvironmentKind, PlatformLifecycleState } from '@kairos/contracts';

const lifecycleStates: ReadonlySet<number> = new Set([
  PlatformLifecycleState.UNINITIALIZED,
  PlatformLifecycleState.STARTING,
  PlatformLifecycleState.RUNNING,
  PlatformLifecycleState.PAUSING,
  PlatformLifecycleState.PAUSED,
  PlatformLifecycleState.RESUMING,
  PlatformLifecycleState.DELETING,
  PlatformLifecycleState.DELETED,
  PlatformLifecycleState.ERROR,
]);

export function isSelfHostedEnvironment(environment: Pick<Environment, 'kind'>): boolean {
  return (
    environment.kind === EnvironmentKind.SELF_HOSTED_LINUX ||
    environment.kind === EnvironmentKind.SELF_HOSTED_MACOS
  );
}

export function validateMainEnvironment(environment: Environment): void {
  if (
    !environment.envId ||
    environment.kind !== EnvironmentKind.PLATFORM_SANDBOX ||
    environment.lifecycleState === undefined ||
    !lifecycleStates.has(environment.lifecycleState)
  ) {
    throw new Error('主环境缺少有效的编号、平台类型或生命周期状态。');
  }
}
