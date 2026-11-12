import { Code, ConnectError } from '@connectrpc/connect';

// Sensitive payloads stay in memory. The general persisted action queue is not used.
export class SettingsRequests {
  pending: { actionId: string; retry: () => Promise<unknown> } | null = null;
  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}
  async execute<T>(operation: (actionId: string) => Promise<T>): Promise<T> {
    if (this.pending) throw new Error('上次保存结果未知，请先重试核对。');
    const actionId = this.createId();
    const retry = () => this.#attempt(actionId, operation);
    this.pending = { actionId, retry };
    return retry();
  }
  async #attempt<T>(actionId: string, operation: (actionId: string) => Promise<T>): Promise<T> {
    try {
      const result = await operation(actionId);
      this.pending = null;
      return result;
    } catch (error) {
      if (
        error instanceof ConnectError &&
        ![Code.Unavailable, Code.DeadlineExceeded, Code.Canceled, Code.Unknown].includes(error.code)
      )
        this.pending = null;
      throw error;
    }
  }
}

export function avatarCrop(
  width: number,
  height: number,
  zoom: number,
  horizontal: number,
  vertical: number,
) {
  const side = Math.min(width, height) / zoom;
  return { x: (width - side) * horizontal, y: (height - side) * vertical, side };
}
