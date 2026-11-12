import { type Environment, EnvironmentKind } from '@kairos/contracts';

export function isSelfHostedEnvironment(environment: Pick<Environment, 'kind'>): boolean {
  return (
    environment.kind === EnvironmentKind.SELF_HOSTED_LINUX ||
    environment.kind === EnvironmentKind.SELF_HOSTED_MACOS
  );
}

export function validateMainEnvironment(environment: Environment): void {
  if (!environment.envId || !isSelfHostedEnvironment(environment)) {
    throw new Error('主环境缺少有效的编号或设备类型。');
  }
}
