import type { EnvironmentStore } from './devices/environment-store.js';
import type { PlatformUse, PlatformUseGateway } from './platform/contracts.js';
import { SessionError } from './sessions/errors.js';

/** Missing platform configuration is an explicit execution failure; self-hosted work stays usable. */
export class UnavailablePlatformUseGateway implements PlatformUseGateway {
  constructor(private readonly environments: EnvironmentStore) {}

  reserveUse(input: PlatformUse): void {
    this.#check(input);
  }

  async ensureReady(input: PlatformUse & { signal: AbortSignal }): Promise<void> {
    input.signal.throwIfAborted();
    this.#check(input);
  }

  releaseUse(_input: PlatformUse): void {}

  #check(input: PlatformUse): void {
    const environment = this.environments.get(input.tenantId, input.envId);
    if (environment.kind === 'platform_sandbox') {
      throw new SessionError('sandbox_unavailable', '平台工作区尚未配置或正在恢复，请稍后重试。', {
        retryable: true,
      });
    }
  }
}
