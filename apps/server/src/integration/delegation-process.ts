import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { openDatabase } from '../storage/database.js';
import { accessToken, deferred, ownerId, requestKey } from './delegation-fixture.js';
import {
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';

const directory = process.env.KAIROS_DELEGATION_TEST_DIRECTORY;
if (!directory) throw new Error('KAIROS_DELEGATION_TEST_DIRECTORY is required.');

class IpcProvider implements ModelProvider {
  readonly #responses = new Map<string, ModelEvent[]>();
  readonly #gates = new Map<string, ReturnType<typeof deferred>>();

  register(key: string, events: ModelEvent[]): void {
    this.#responses.set(key, events);
    if (!this.#gates.has(key)) this.#gates.set(key, deferred());
  }

  resolve(key: string): void {
    this.#gates.get(key)?.resolve();
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = requestKey(request);
    process.send?.({ type: 'request', key, request });
    const events = this.#responses.get(key);
    const gate = this.#gates.get(key);
    if (!events || !gate) throw new Error(`No controlled response registered for ${key}.`);
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    const current = this.#responses.get(key);
    if (!current) throw new Error(`No controlled response registered for ${key}.`);
    if (current.length === 0) throw new Error(`Controlled model failure for ${key}.`);
    for (const event of current) yield event;
  }
}

const provider = new IpcProvider();
const initialResponses = JSON.parse(process.env.KAIROS_DELEGATION_TEST_RESPONSES ?? '[]') as Array<{
  key: string;
  events: ModelEvent[];
}>;
for (const initial of initialResponses) provider.register(initial.key, initial.events);
const initialResolved = JSON.parse(process.env.KAIROS_DELEGATION_TEST_RESOLVED ?? '[]') as string[];
for (const key of initialResolved) provider.resolve(key);
const database = openDatabase(join(directory, 'server.sqlite'));
seedTestEnvironment(database, ownerId);
const server = createServer(database, false, {
  tenantId: ownerId,
  sessionToken: accessToken,
  model: {
    provider,
    providerId: 'delegation-process-provider',
    modelId: 'delegation-process-model',
    contextWindowTokens: 128_000,
    outputReserveTokens: 4096,
  },
});

process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const type = Reflect.get(message, 'type');
  const key = Reflect.get(message, 'key');
  const registrationId = Reflect.get(message, 'registrationId');
  if (type === 'register' && typeof key === 'string' && typeof registrationId === 'string') {
    const events = Reflect.get(message, 'events');
    if (!Array.isArray(events)) throw new Error('Invalid Provider registration.');
    provider.register(key, events as ModelEvent[]);
    process.send?.({ type: 'registered', registrationId });
  } else if (type === 'resolve' && typeof key === 'string') {
    provider.resolve(key);
  }
});

await server.listen({ host: '127.0.0.1', port: 0 });
const address = server.server.address() as AddressInfo;
process.send?.({ type: 'ready', port: address.port });
