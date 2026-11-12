export class RequestSlots {
  readonly #maximum: number;
  readonly #waiting: Array<{ start: () => void; reject: (error: unknown) => void }> = [];
  #active = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new RangeError('The model request limit must be a positive safe integer.');
    }
    this.#maximum = maximum;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#active < this.#maximum) {
      this.#active += 1;
      return this.#release();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        start: () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        reject: (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      };
      const abort = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
        waiter.reject(signal.reason);
      };
      this.#waiting.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
    const release = this.#release();
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return release;
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next.start();
      else this.#active -= 1;
    };
  }
}
