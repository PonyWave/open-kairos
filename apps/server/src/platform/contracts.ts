export type PlatformUseKind = 'run' | 'operation' | 'reload';

export interface PlatformUse {
  tenantId: string;
  envId: string;
  usageId: string;
  kind: PlatformUseKind;
}

/** Server execution uses this port; sandbox lifecycle tasks remain owned by its implementation. */
export interface PlatformUseGateway {
  /** Reserve synchronously before ordinary Run scheduling; capacity errors never enter that queue. */
  reserveUse(input: PlatformUse): void;
  /** Wait only for this environment's accepted lifecycle work, using its existing reservation. */
  ensureReady(input: PlatformUse & { signal: AbortSignal }): Promise<void>;
  /** Remove the reference; the last settled use starts the durable idle period. */
  releaseUse(input: PlatformUse): void;
}
