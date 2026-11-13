import { type Environment, EnvironmentBindingStatus, EnvironmentKind } from '@kairos/contracts';

export function isSelfHostedEnvironment(environment: Pick<Environment, 'kind'>): boolean {
  return (
    environment.kind === EnvironmentKind.SELF_HOSTED_LINUX ||
    environment.kind === EnvironmentKind.SELF_HOSTED_MACOS
  );
}

export function workspaceSelectableEnvironments(
  environments: readonly Environment[],
  currentEnvId?: string,
): Environment[] {
  const usable = environments.filter(
    (environment) =>
      isSelfHostedEnvironment(environment) &&
      environment.bindingStatus === EnvironmentBindingStatus.ACTIVE,
  );
  if (currentEnvId && !usable.some((environment) => environment.envId === currentEnvId)) {
    const current = environments.find((environment) => environment.envId === currentEnvId);
    if (current) usable.push(current);
  }
  return usable;
}

export function validateMainEnvironment(environment: Environment): void {
  if (!environment.envId || !isSelfHostedEnvironment(environment)) {
    throw new Error('主环境缺少有效的编号或设备类型。');
  }
}
