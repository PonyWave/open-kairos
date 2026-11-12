import { expect, it, vi } from 'vitest';
import { ControlledProvider, response } from '../integration/delegation-fixture.js';
import {
  controlledEnvironmentDependencies,
  seedTestEnvironment,
} from '../integration/environment-fixture.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { AutomationService } from './service.js';

const ownerId = 'automation-runtime-owner';

async function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database, {
    mainEnvironment: { envId: 'env-main-1', workspace: '/workspace' },
  });
  const provider = new ControlledProvider();
  let coordinator: RunCoordinator;
  const service = new AutomationService(store, {
    deliver: (input, runId) => coordinator.deliver(input, runId),
  });
  coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(database, ownerId),
    store,
    automations: service,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  const main = store.getOrCreateMainThread(ownerId);
  return { database, store, provider, coordinator, service, main };
}

async function cleanup(current: Awaited<ReturnType<typeof fixture>>) {
  await current.service.close();
  await current.coordinator.close();
  current.database.close();
}

async function waitRequest(provider: ControlledProvider, key: string) {
  await vi.waitFor(
    () => expect(provider.requests.some((request) => request.key === key)).toBe(true),
    {
      timeout: 3000,
    },
  );
}

function automationKey(input: { text: string; automation: unknown }): string {
  if (typeof input.automation !== 'object' || input.automation === null) {
    throw new Error('Automation provenance is missing.');
  }
  const reference = input.automation as {
    trigger: string;
    scheduleId: string;
    fireId: string;
    scheduledAt: string;
  };
  return `user:Kairos Automation trigger; trigger=${reference.trigger}; schedule_id=${reference.scheduleId}; fire_id=${reference.fireId}; scheduled_at=${reference.scheduledAt}.\nThe configured Automation prompt follows; it is not a new human instruction:\n\n${input.text}`;
}

it('queues Automation input behind an in-flight model request without interrupting it', async () => {
  const current = await fixture();
  try {
    current.provider.register('user:busy', response('busy complete'));
    const sent = current.store.sendMessage({
      ownerId,
      clientActionId: 'busy-input',
      method: 'SendMessage',
      parameters: { threadId: current.main.threadId, text: 'busy', mode: 'follow_up' },
      threadId: current.main.threadId,
      text: 'busy',
      mode: 'follow_up',
    });
    await current.coordinator.deliver(sent.input, sent.runId);
    await waitRequest(current.provider, 'user:busy');

    const automation = current.service.create({
      ownerId,
      clientActionId: 'create-main-automation',
      name: '主对话定时任务',
      prompt: '定时继续',
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
      target: { kind: 'main' },
      enabled: false,
    });
    const fire = await current.service.runNow({
      ownerId,
      clientActionId: 'run-main-automation',
      scheduleId: automation.scheduleId,
    });
    expect(fire.acceptedRunId).toBe(sent.runId);
    expect(current.provider.requests).toHaveLength(1);
    expect(current.store.getInput(ownerId, fire.inputId ?? '')).toMatchObject({
      status: 'queued',
      mode: 'follow_up',
      source: 'automation',
    });

    const input = current.store.getInput(ownerId, fire.inputId ?? '');
    const key = automationKey(input);
    current.provider.register(key, response('Automation complete'));
    current.provider.resolve('user:busy');
    await waitRequest(current.provider, key);
    const request = current.provider.requests.find((candidate) => candidate.key === key)?.request;
    expect(JSON.stringify(request?.messages.at(-1))).toContain('trigger=run_now');
    expect(JSON.stringify(request?.messages.at(-1))).toContain('not a new human instruction');
    current.provider.resolve(key);
    await vi.waitFor(() => {
      expect(current.store.getRunById(sent.runId).status).toBe('completed');
      expect(
        current.service.store.getFire(ownerId, automation.scheduleId, fire.fireId).status,
      ).toBe('completed');
    });
    expect(current.store.getRunById(sent.runId).inputIds).toEqual([
      sent.input.inputId,
      input.inputId,
    ]);
    const messages = current.store.listContext(ownerId, current.main.threadId, 'thread');
    const stored = messages.find((message) => message.sourceInputId === input.inputId);
    expect(stored).toMatchObject({
      source: 'automation',
      automation: { fireId: fire.fireId, trigger: 'run_now' },
    });
  } finally {
    await cleanup(current);
  }
});

it('persists model failure as the fire terminal error', async () => {
  const current = await fixture();
  try {
    const automation = current.service.create({
      ownerId,
      clientActionId: 'create-failing-automation',
      name: '失败任务',
      prompt: '触发模型失败',
      schedule: { kind: 'once', runAt: '2026-01-01T00:00:00.000Z', timeZone: 'UTC' },
      target: { kind: 'new_automation_only' },
      enabled: false,
    });
    const accepted = await current.service.runNow({
      ownerId,
      clientActionId: 'run-failing-automation',
      scheduleId: automation.scheduleId,
    });
    const input = current.store.getInput(ownerId, accepted.inputId ?? '');
    const key = automationKey(input);
    current.provider.register(key, []);
    await vi.waitFor(() => {
      if (!current.provider.requests.some((request) => request.key === key)) {
        throw new Error('Automation model request has not arrived.');
      }
    });
    current.provider.resolve(key);
    await vi.waitFor(() => {
      const fire = current.service.store.getFire(ownerId, automation.scheduleId, accepted.fireId);
      expect(fire).toMatchObject({ status: 'failed', error: { code: 'internal' } });
      expect(fire.consumedRunId).not.toBeNull();
    });
    const hiddenId = accepted.targetThreadId ?? '';
    expect(current.store.getThread(ownerId, hiddenId).automationOnly).toBe(true);
    expect(
      current.store.listThreads(ownerId, 0n, 20).map((thread) => thread.threadId),
    ).not.toContain(hiddenId);
  } finally {
    await cleanup(current);
  }
});

it('resolves and projects the sandbox alias throughout Automation management and run_now', async () => {
  const current = await fixture();
  try {
    seedTestEnvironment(current.database, ownerId, 'env-1', '/srv/one');
    current.provider.register(
      'user:create sandbox automation',
      response('', [
        {
          id: 'alias-create',
          name: 'automation_create',
          arguments: {
            name: 'sandbox task',
            prompt: 'run in sandbox',
            schedule: { kind: 'cron', expression: '0 9 * * *', time_zone: 'Asia/Shanghai' },
            target: { kind: 'new_task', allowed_env: ['main'] },
            enabled: false,
          },
        },
      ]),
    );
    current.provider.respond(
      'tool:alias-create',
      response('', [{ id: 'alias-list', name: 'automation_list', arguments: {} }]),
    );
    current.provider.respond('tool:alias-list', response('created'));
    const sent = current.store.sendMessage({
      ownerId,
      clientActionId: 'alias-create-input',
      method: 'SendMessage',
      parameters: {
        threadId: current.main.threadId,
        text: 'create sandbox automation',
        mode: 'follow_up',
      },
      threadId: current.main.threadId,
      text: 'create sandbox automation',
      mode: 'follow_up',
    });
    await current.coordinator.deliver(sent.input, sent.runId);
    await waitRequest(current.provider, 'user:create sandbox automation');
    current.provider.resolve('user:create sandbox automation');
    await vi.waitFor(() => expect(current.store.getRunById(sent.runId).status).toBe('completed'));
    const automation = current.service.store.listAutomations(ownerId, 0n, 1)[0];
    if (!automation) throw new Error('Automation was not created.');
    const scheduleId = automation.scheduleId;
    const sandboxId = automation.target.environmentPolicy?.allowedEnv[0];
    expect(sandboxId).toBeDefined();
    expect(sandboxId).not.toBe('main');

    current.provider.register(
      'user:manage sandbox automation',
      response('', [
        { id: 'alias-read', name: 'automation_read', arguments: { schedule_id: scheduleId } },
      ]),
    );
    current.provider.respond(
      'tool:alias-read',
      response('', [
        {
          id: 'alias-update',
          name: 'automation_update',
          arguments: {
            schedule_id: scheduleId,
            expected_version: 1,
            name: 'updated sandbox task',
            target: { kind: 'new_task', allowed_env: ['main', 'env-1'] },
          },
        },
      ]),
    );
    current.provider.respond(
      'tool:alias-update',
      response('', [
        {
          id: 'alias-run-now',
          name: 'automation_run_now',
          arguments: { schedule_id: scheduleId },
        },
      ]),
    );
    current.provider.respond('tool:alias-run-now', response('accepted'));
    const manage = current.store.sendMessage({
      ownerId,
      clientActionId: 'alias-manage-input',
      method: 'SendMessage',
      parameters: {
        threadId: current.main.threadId,
        text: 'manage sandbox automation',
        mode: 'follow_up',
      },
      threadId: current.main.threadId,
      text: 'manage sandbox automation',
      mode: 'follow_up',
    });
    await current.coordinator.deliver(manage.input, manage.runId);
    await waitRequest(current.provider, 'user:manage sandbox automation');
    current.provider.resolve('user:manage sandbox automation');
    await vi.waitFor(() => expect(current.store.getRunById(manage.runId).status).toBe('completed'));

    const messages = current.store.listContext(ownerId, current.main.threadId, 'thread');
    const contents = [
      'alias-create',
      'alias-list',
      'alias-read',
      'alias-update',
      'alias-run-now',
    ].map((callId) => {
      const message = messages.find(
        (candidate) =>
          candidate.message.role === 'tool' && candidate.message.tool_call_id === callId,
      );
      if (!message) throw new Error(`Missing tool result ${callId}.`);
      return message.message.content;
    });
    for (const content of contents) expect(content).not.toContain(sandboxId ?? '');
    expect(contents[0]).toContain('"allowedEnv":["main"]');
    expect(contents[1]).toContain('"allowedEnv":["main"]');
    expect(contents[2]).toContain('"allowedEnv":["main"]');
    expect(contents[3]).toContain('"allowedEnv":["main","env-1"]');
    expect(contents[4]).toMatch(/"status":"(queued|running|completed)"/);

    const updated = current.service.store.getAutomation(ownerId, scheduleId);
    expect(updated.target.environmentPolicy?.allowedEnv).toEqual([sandboxId, 'env-1']);
    const fire = current.service.store.listFires(ownerId, scheduleId, 0n, 1)[0];
    if (!fire) throw new Error('run_now did not create a fire.');
    expect(fire.inputId).not.toBeNull();
    const targetPolicy = current.store.agentEnvironments.requirePolicy(
      fire.targetThreadId ?? '',
      'thread',
    );
    expect(targetPolicy.allowedEnv).toEqual([sandboxId, 'env-1']);
  } finally {
    await cleanup(current);
  }
});
