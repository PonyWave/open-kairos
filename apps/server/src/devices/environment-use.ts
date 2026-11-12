export type EnvironmentUseKind = 'run' | 'operation' | 'reload';

export interface EnvironmentUse {
  tenantId: string;
  envId: string;
  usageId: string;
  kind: EnvironmentUseKind;
  /** Workspace directory checked during ensureReady; defaults to the main environment root. */
  pwd?: string;
}

/** Server execution reserves the default environment through this port before scheduling work. */
export interface EnvironmentUseGateway {
  /** Reserve synchronously before ordinary Run scheduling. */
  reserveUse(input: EnvironmentUse): void;
  /** Wait until the reserved environment is ready for execution. */
  ensureReady(input: EnvironmentUse & { signal: AbortSignal }): Promise<void>;
  /** Remove the reference. */
  releaseUse(input: EnvironmentUse): void;
}
