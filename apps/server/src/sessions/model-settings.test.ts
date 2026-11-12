import { ConfiguredModelSchema, create, SaveModelConnectionRequestSchema } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { seedTestSession } from '../integration/test-authentication.js';
import { SettingsStore } from '../settings/store.js';
import { openDatabase } from '../storage/database.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

function data(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function response(apiType: 1 | 2 | 3, delegate = false): Response {
  if (apiType === 1) {
    const delta = delegate
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'delegate-1',
              type: 'function',
              function: {
                name: 'subagent',
                arguments: JSON.stringify({ task: 'child', mode: 'foreground' }),
              },
            },
          ],
        }
      : { content: 'complete' };
    return new Response(
      `${data({ choices: [{ index: 0, delta, finish_reason: delegate ? 'tool_calls' : 'stop' }] })}${data({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}${data('[DONE]')}`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (apiType === 2) {
    const output = delegate
      ? [
          data({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'responses-item-1',
              call_id: 'delegate-1',
              name: 'subagent',
              arguments: JSON.stringify({ task: 'child', mode: 'foreground' }),
            },
          }),
          data({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'responses-item-1',
              call_id: 'delegate-1',
              name: 'subagent',
              arguments: JSON.stringify({ task: 'child', mode: 'foreground' }),
            },
          }),
        ]
      : [data({ type: 'response.output_text.delta', delta: 'complete' })];
    return new Response(
      `${output.join('')}${data({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })}`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  const blocks = delegate
    ? [
        data({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'delegate-1',
            name: 'subagent',
            input: { task: 'child', mode: 'foreground' },
          },
        }),
        data({ type: 'content_block_stop', index: 0 }),
      ]
    : [
        data({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'complete' },
        }),
        data({ type: 'content_block_stop', index: 0 }),
      ];
  return new Response(
    `${data({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } })}${blocks.join('')}${data({ type: 'message_delta', delta: { stop_reason: delegate ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } })}${data({ type: 'message_stop' })}`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

it.each([1, 2, 3] as const)(
  'uses captured model and credentials in a Run and its child with apiType %i, then selects new settings',
  async (apiType) => {
    const database = openDatabase(':memory:');
    const store = new SessionStore(database);
    seedTestSession(database, 'owner', 'token');
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<{ body: string; key: string | null; path: string }> = [];
    const settings = new SettingsStore(database, {
      secret: 'runtime-settings-test-secret-at-least-32-characters',
      fetch: async (input, init) => {
        const index = calls.length;
        const headers = new Headers(init?.headers);
        calls.push({
          body: String(init?.body),
          key: headers.get(apiType === 3 ? 'x-api-key' : 'authorization'),
          path: String(input),
        });
        if (index === 0) {
          await barrier;
          return response(apiType, true);
        }
        return response(apiType);
      },
    });
    const baseUrl = `https://models.example.com${apiType === 3 ? '' : '/v1'}`;
    const configuration = create(SaveModelConnectionRequestSchema, {
      id: 'connection',
      name: 'Fixture',
      apiType,
      baseUrl,
      clientActionId: 'save-old',
      keyChange: { case: 'replaceKey', value: 'old-key' },
      models: [
        create(ConfiguredModelSchema, {
          id: 'model',
          name: 'Fixture',
          modelId: 'old-model',
          contextWindow: 128000,
          maxOutputTokens: 4096,
          timeoutMs: 30000,
        }),
      ],
    });
    settings.save('owner', configuration);
    const errors: unknown[] = [];
    const coordinator = new RunCoordinator({
      store,
      settings,
      ...controlledEnvironmentDependencies(database, 'owner'),
      onError: (error) => errors.push(error),
    });
    const thread = store.getOrCreateMainThread('owner');
    const send = (id: string) =>
      store.sendMessage({
        ownerId: 'owner',
        clientActionId: id,
        method: 'SendMessage',
        parameters: {},
        threadId: thread.threadId,
        text: id,
        mode: 'follow_up',
      });
    const expectedPath = {
      1: 'https://models.example.com/v1/chat/completions',
      2: 'https://models.example.com/v1/responses',
      3: 'https://models.example.com/v1/messages',
    }[apiType];
    const credential = (value: string) => (apiType === 3 ? value : `Bearer ${value}`);
    try {
      const first = send('first');
      await coordinator.deliver(first.input, first.runId);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      settings.save(
        'owner',
        create(SaveModelConnectionRequestSchema, {
          ...configuration,
          clientActionId: 'save-new',
          expectedVersion: 1,
          keyChange: { case: 'replaceKey', value: 'new-key' },
          models: configuration.models.map((model) => ({ ...model, modelId: 'new-model' })),
        }),
      );
      release();
      await vi.waitFor(
        () => {
          expect(store.getRunById(first.runId).status).toBe('completed');
          expect(coordinator.activeThreadCount).toBe(0);
        },
        { timeout: 5000 },
      );
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(JSON.parse(call.body).model).toBe('old-model');
        expect(call.key).toBe(credential('old-key'));
        expect(call.path).toBe(expectedPath);
      }
      const second = send('second');
      await coordinator.deliver(second.input, second.runId);
      await vi.waitFor(() => expect(store.getRunById(second.runId).status).toBe('completed'));
      expect(JSON.parse(calls.at(-1)?.body ?? '{}').model).toBe('new-model');
      expect(calls.at(-1)?.key).toBe(credential('new-key'));
      settings.save(
        'owner',
        create(SaveModelConnectionRequestSchema, {
          ...configuration,
          id: 'fallback',
          clientActionId: 'fallback',
          expectedVersion: 2,
          models: configuration.models.map((model) => ({ ...model, id: 'fallback-model' })),
        }),
      );
      settings.setDefault('owner', {
        clientActionId: 'default-fallback',
        expectedVersion: 3,
        modelId: 'fallback-model',
      });
      settings.delete('owner', {
        clientActionId: 'delete-original',
        expectedVersion: 4,
        id: 'connection',
      });
      settings.save(
        'owner',
        create(SaveModelConnectionRequestSchema, {
          ...configuration,
          clientActionId: 'recreate-original',
          expectedVersion: 5,
          keyChange: { case: 'replaceKey', value: 'recreated-key' },
        }),
      );
      settings.setDefault('owner', {
        clientActionId: 'default-recreated',
        expectedVersion: 6,
        modelId: 'model',
      });
      const third = send('third');
      await coordinator.deliver(third.input, third.runId);
      await vi.waitFor(() => expect(store.getRunById(third.runId).status).toBe('completed'));
      expect(JSON.parse(calls.at(-1)?.body ?? '{}').model).toBe('old-model');
      expect(calls.at(-1)?.key).toBe(credential('recreated-key'));
      expect(errors).toEqual([]);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM run_model_configurations').get()?.count,
      ).toBe(4);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM request_model_configurations').get()?.count,
      ).toBe(5);
    } finally {
      release();
      await coordinator.close();
      database.close();
    }
  },
);
