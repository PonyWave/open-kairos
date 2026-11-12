import type { ModelEvent, ModelProvider, ModelRequest } from './index.js';

export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private readonly responses: ModelEvent[][];

  constructor(responses: readonly (readonly ModelEvent[])[]) {
    this.responses = responses.map((events) => structuredClone([...events]));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const events = this.responses.shift();
    if (!events) throw new Error('No scripted model response remains.');
    this.requests.push(structuredClone(request));
    for (const event of events) {
      signal.throwIfAborted();
      yield event;
    }
  }
}
