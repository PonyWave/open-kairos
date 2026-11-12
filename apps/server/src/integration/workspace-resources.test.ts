import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '@connectrpc/connect';
import { CompactContextStatus, RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ModelInputService,
  runtimeSpecFingerprintFromRequest,
} from '../context/model-input-service.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { AgentEnvironmentRuntime } from '../sessions/environment-runtime.js';
import { SessionStore } from '../sessions/store.js';
import {
  ControlledSlashProvider,
  CountingWorkspaceLoader,
  closeSlashFixture,
  crashSlashFixture,
  createSlashThread,
  deferred,
  expectSlashError,
  type SlashFixture,
  sendSlashMessage,
  slashErrorTerminal,
  slashOwnerId,
  startSlashFixture,
  systemText,
  tableCounts,
  waitSlashRequests,
  waitSlashRun,
} from './compact-fixture.js';
import { ControlledEnvironmentUseGateway } from './environment-fixture.js';

async function makeWorkspace(
  prefix: string,
  version: 'v1' | 'v2' = 'v1',
): Promise<{ directory: string; workspace: string }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(directory, 'workspace');
  await mkdir(join(workspace, '.agents', 'skills', 'alpha'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), `AGENTS ${version} marker`);
  await writeFile(
    join(workspace, '.agents', 'skills', 'alpha', 'SKILL.md'),
    `Skill alpha ${version} marker`,
  );
  return { directory, workspace };
}

async function cleanUp(directory: string, fixture: SlashFixture | undefined): Promise<void> {
  if (fixture) await closeSlashFixture(fixture);
  await rm(directory, { recursive: true, force: true });
}

type RequestEvidence = 'preparing' | 'prepared' | 'dispatched' | 'legacy';

async function seedInterruptedRequest(
  fixture: SlashFixture,
  threadId: string,
  requestId: string,
  evidence: RequestEvidence,
) {
  const store = new SessionStore(fixture.database);
  const text = `pending input for ${requestId}`;
  const sent = store.sendMessage({
    ownerId: slashOwnerId,
    clientActionId: `send-${requestId}`,
    method: 'SendMessage',
    parameters: { threadId, text, mode: 'follow_up' },
    threadId,
    text,
    mode: 'follow_up',
  });
  const user = store.appendModelMessage({
    runId: sent.runId,
    inputId: sent.input.inputId,
    message: { role: 'user', content: text },
  });
  const environmentRuntime = new AgentEnvironmentRuntime({
    store,
    environments: new EnvironmentStore(fixture.database),
    operations: fixture.environmentOperations,
    environmentUse: new ControlledEnvironmentUseGateway(fixture.database),
  });
  const run = store.getRunById(sent.runId);
  environmentRuntime.reserveRun(run);
  try {
    await environmentRuntime.prepare(run, new AbortController().signal);
  } finally {
    environmentRuntime.releaseRun(run);
  }
  await environmentRuntime.close();
  store.updateRunStatus(sent.runId, 'interrupted');
  const modelInputs = new ModelInputService(fixture.database, { countTokens: () => 100 });
  const prepared = await modelInputs.prepare({
    requestId,
    threadId,
    agentId: 'thread',
    systemInstructions: ['code v1 base prompt', 'workspace v1 instructions'],
    tools: [
      {
        name: 'code_v1_only_tool',
        description: 'code v1 tool definition',
        parameters: {
          type: 'object',
          properties: { legacy: { type: 'string' } },
          required: ['legacy'],
          additionalProperties: false,
        },
      },
    ],
    pendingContextSeqs: [user.seq],
    contextWindowTokens: 1000,
    outputReserveTokens: 100,
  });
  store.setCurrentRequestId(sent.runId, requestId);
  if (evidence === 'prepared' || evidence === 'dispatched') {
    store.recordModelRequestPrepared(sent.runId, requestId);
  }
  if (evidence === 'dispatched') store.recordModelRequestDispatched(sent.runId, requestId);
  if (evidence === 'preparing') {
    fixture.database
      .prepare("UPDATE model_request_records SET status = 'preparing' WHERE request_id = ?")
      .run(requestId);
  }
  return { runId: sent.runId, inputId: sent.input.inputId, text, user, prepared };
}

function requestAudit(fixture: SlashFixture, requestId: string) {
  return z
    .record(z.string(), z.unknown())
    .parse(
      fixture.database
        .prepare('SELECT * FROM model_request_records WHERE request_id = ?')
        .get(requestId),
    );
}

function currentRequestId(fixture: SlashFixture, runId: string): string | null {
  return z
    .object({ current_request_id: z.string().nullable() })
    .parse(
      fixture.database.prepare('SELECT current_request_id FROM runs WHERE run_id = ?').get(runId),
    ).current_request_id;
}

function modelInputAudit(fixture: SlashFixture, threadId: string) {
  return {
    state: z
      .record(z.string(), z.unknown())
      .parse(
        fixture.database
          .prepare('SELECT * FROM model_input_states WHERE thread_id = ? AND agent_id = ?')
          .get(threadId, 'thread'),
      ),
    recaps: z
      .array(z.record(z.string(), z.unknown()))
      .parse(
        fixture.database
          .prepare(
            'SELECT * FROM model_input_recaps WHERE thread_id = ? AND agent_id = ? ORDER BY merge_position',
          )
          .all(threadId, 'thread'),
      ),
  };
}

async function writeV2Workspace(workspace: string): Promise<void> {
  await writeFile(join(workspace, 'AGENTS.md'), 'AGENTS v2 marker');
  await rm(join(workspace, '.agents', 'skills', 'alpha'), { recursive: true });
  await mkdir(join(workspace, '.agents', 'skills', 'beta'), { recursive: true });
  await writeFile(join(workspace, '.agents', 'skills', 'beta', 'SKILL.md'), 'Skill beta v2 marker');
}

it('pins an active Run to v1, applies v2 to the next Run, and replays reload without side effects', async () => {
  const { directory, workspace } = await makeWorkspace('kairos-reload-network-v1-v2-');
  const provider = new ControlledSlashProvider();
  const gate = deferred();
  provider.enqueue({ kind: 'normal', content: 'v1 answer', gate: gate.promise });
  provider.enqueue({ kind: 'normal', content: 'v2 answer' });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'network-reload-thread');
    const modelBefore = await fixture.clients.model.getModelStatus({});
    const first = await sendSlashMessage(fixture, threadId, 'use v1', 'network-reload-v1-input');
    await waitSlashRequests(provider, 'normal', 1);
    const firstSystem = systemText(
      provider.byKind('normal')[0]?.request ?? { messages: [], tools: [] },
    );
    expect(firstSystem).toContain('AGENTS v1 marker');
    expect(firstSystem).toContain('Skill alpha v1 marker');
    expect(firstSystem).toContain('<workspace-resource path="AGENTS.md">');
    expect(firstSystem).toContain('<workspace-resource path=".agents/skills/alpha/SKILL.md">');

    const countsWhileActive = tableCounts(fixture, threadId);
    const loader = fixture.workspaceResourceLoader as CountingWorkspaceLoader;
    const loadsWhileActive = loader.calls;
    const busyError = await expectSlashError(
      fixture.clients.workspace.reloadResources({
        threadId,
        clientActionId: 'network-reload-busy',
      }),
      Code.FailedPrecondition,
    );
    expect(slashErrorTerminal(busyError)).toBeUndefined();
    expect(loader.calls).toBe(loadsWhileActive);
    expect(tableCounts(fixture, threadId)).toEqual(countsWhileActive);
    expect(provider.requests).toHaveLength(1);
    expect(
      (await fixture.clients.thread.getThread({ threadId })).snapshot?.runs.find(
        (run) => run.runId === first.runId,
      )?.status,
    ).toBe(RunStatus.RUNNING);
    gate.resolve();
    await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    expect(systemText(provider.byKind('normal')[0]?.request ?? { messages: [], tools: [] })).toBe(
      firstSystem,
    );
    const initial = await fixture.clients.workspace.reloadResources({
      threadId,
      clientActionId: 'network-reload-initial-check',
    });
    expect(initial).toMatchObject({
      changed: false,
      resources: ['.agents/skills/alpha/SKILL.md', 'AGENTS.md'],
      added: [],
      updated: [],
      removed: [],
      runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeChanged: false,
    });
    await writeV2Workspace(workspace);

    const countsBeforeReload = tableCounts(fixture, threadId);
    const request = { threadId, clientActionId: 'network-reload-v2' };
    const reloaded = await fixture.clients.workspace.reloadResources(request);
    expect(reloaded).toMatchObject({
      changed: true,
      resources: ['.agents/skills/beta/SKILL.md', 'AGENTS.md'],
      added: ['.agents/skills/beta/SKILL.md'],
      updated: ['AGENTS.md'],
      removed: ['.agents/skills/alpha/SKILL.md'],
      runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeChanged: true,
    });
    expect(reloaded.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(reloaded.snapshotId).not.toBe(initial.snapshotId);
    expect(tableCounts(fixture, threadId)).toEqual({
      ...countsBeforeReload,
      events: countsBeforeReload.events + 1,
    });
    expect(provider.requests).toHaveLength(1);
    const loadsAfterReload = loader.calls;
    expect(await fixture.clients.workspace.reloadResources(request)).toEqual(reloaded);
    expect(loader.calls).toBe(loadsAfterReload);
    expect(tableCounts(fixture, threadId)).toEqual({
      ...countsBeforeReload,
      events: countsBeforeReload.events + 1,
    });

    const unchanged = await fixture.clients.workspace.reloadResources({
      threadId,
      clientActionId: 'network-reload-v2-unchanged',
    });
    expect(unchanged).toMatchObject({
      snapshotId: reloaded.snapshotId,
      changed: false,
      resources: reloaded.resources,
      added: [],
      updated: [],
      removed: [],
      runtimeFingerprint: reloaded.runtimeFingerprint,
      runtimeChanged: true,
    });
    expect(tableCounts(fixture, threadId)).toEqual({
      ...countsBeforeReload,
      events: countsBeforeReload.events + 2,
    });
    const otherThreadId = await createSlashThread(fixture, 'network-reload-other-thread');
    await expect(
      fixture.clients.workspace.reloadResources({
        threadId: otherThreadId,
        clientActionId: request.clientActionId,
      }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    await expect(fixture.clients.context.compactContext(request)).rejects.toMatchObject({
      code: Code.AlreadyExists,
    });

    const second = await sendSlashMessage(fixture, threadId, 'use v2', 'network-reload-v2-input');
    await waitSlashRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    expect(provider.byKind('normal')).toHaveLength(2);
    const secondRequest = provider.byKind('normal')[1]?.request;
    if (!secondRequest) throw new Error('The second runtime request is missing.');
    const secondSystem = systemText(secondRequest);
    expect(secondSystem).toContain('AGENTS v2 marker');
    expect(secondSystem).toContain('Skill beta v2 marker');
    expect(secondSystem).not.toContain('AGENTS v1 marker');
    expect(secondSystem).not.toContain('Skill alpha v1 marker');
    expect(secondSystem).not.toBe(firstSystem);
    expect(runtimeSpecFingerprintFromRequest(secondRequest)).toBe(reloaded.runtimeFingerprint);
    expect(await fixture.clients.model.getModelStatus({})).toEqual(modelBefore);
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({
      count: 2,
    });
    const settled = await fixture.clients.workspace.reloadResources({
      threadId,
      clientActionId: 'network-reload-v2-settled',
    });
    expect(settled).toMatchObject({
      snapshotId: reloaded.snapshotId,
      changed: false,
      runtimeFingerprint: reloaded.runtimeFingerprint,
      runtimeChanged: false,
    });
    expect(provider.requests).toHaveLength(2);
    expect(
      z
        .array(z.object({ method: z.string(), response_json: z.string() }))
        .parse(
          fixture.database
            .prepare(
              "SELECT method, response_json FROM client_actions WHERE method = 'ReloadEnvironmentResources' ORDER BY created_at, client_action_id",
            )
            .all(),
        ),
    ).toEqual([
      {
        method: 'ReloadEnvironmentResources',
        response_json: expect.stringContaining('"completed"'),
      },
      {
        method: 'ReloadEnvironmentResources',
        response_json: expect.stringContaining('"completed"'),
      },
      {
        method: 'ReloadEnvironmentResources',
        response_json: expect.stringContaining('"completed"'),
      },
      {
        method: 'ReloadEnvironmentResources',
        response_json: expect.stringContaining('"completed"'),
      },
    ]);
  } finally {
    gate.resolve();
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('keeps the last valid v2 snapshot after a failed reload and stores a replayable failure', async () => {
  const { directory, workspace } = await makeWorkspace('kairos-reload-network-failure-', 'v2');
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'still v2 answer' });
  provider.enqueue({ kind: 'normal', content: 'last valid resources answer' });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'network-reload-failure-thread');
    const first = await sendSlashMessage(
      fixture,
      threadId,
      'load initial v2 resources',
      'network-reload-failure-first-input',
    );
    await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    const initial = await fixture.clients.workspace.reloadResources({
      threadId,
      clientActionId: 'network-reload-failure-initial',
    });
    expect(initial.changed).toBe(false);
    await writeFile(join(workspace, 'AGENTS.md'), 'AGENTS v3 must not activate');
    await writeFile(join(workspace, '.agents', 'skills', 'alpha', 'SKILL.md'), '   \n');
    const countsBeforeFailure = tableCounts(fixture, threadId);
    const providerRequestsBeforeFailure = provider.requests.length;
    const request = { threadId, clientActionId: 'network-reload-invalid-v3' };
    const failure = await expectSlashError(
      fixture.clients.workspace.reloadResources(request),
      Code.FailedPrecondition,
    );
    expect(slashErrorTerminal(failure)).toBe(true);
    expect(tableCounts(fixture, threadId)).toEqual(countsBeforeFailure);
    expect(provider.requests).toHaveLength(providerRequestsBeforeFailure);
    const failedReceipt = z
      .object({ response_json: z.string() })
      .parse(
        fixture.database
          .prepare(
            "SELECT response_json FROM client_actions WHERE client_action_id = 'network-reload-invalid-v3'",
          )
          .get(),
      );
    expect(failedReceipt.response_json).toContain('"status":"failed"');
    expect(failedReceipt.response_json).toContain('"code":"failed_precondition"');
    const loader = fixture.workspaceResourceLoader as CountingWorkspaceLoader;
    const loadsAfterFailure = loader.calls;
    const replayedFailure = await expectSlashError(
      fixture.clients.workspace.reloadResources(request),
      Code.FailedPrecondition,
    );
    expect(slashErrorTerminal(replayedFailure)).toBe(true);
    expect(loader.calls).toBe(loadsAfterFailure);

    const next = await sendSlashMessage(
      fixture,
      threadId,
      'verify last valid resources',
      'network-reload-after-failure-input',
    );
    await waitSlashRun(fixture, threadId, next.runId, RunStatus.COMPLETED);
    const requestAfterFailure = provider.byKind('normal')[1]?.request;
    if (!requestAfterFailure) throw new Error('The post-failure model request is missing.');
    const instructions = systemText(requestAfterFailure);
    expect(instructions).toContain('AGENTS v2 marker');
    expect(instructions).toContain('Skill alpha v2 marker');
    expect(instructions).not.toContain('AGENTS v3 must not activate');
    await writeFile(join(workspace, 'AGENTS.md'), 'AGENTS v2 marker');
    await writeFile(
      join(workspace, '.agents', 'skills', 'alpha', 'SKILL.md'),
      'Skill alpha v2 marker',
    );
    const current = await fixture.clients.workspace.reloadResources({
      threadId,
      clientActionId: 'network-reload-after-failure-unchanged',
    });
    expect(current).toMatchObject({
      snapshotId: initial.snapshotId,
      changed: false,
      added: [],
      updated: [],
      removed: [],
    });
    expect(current.snapshotId).toBe(initial.snapshotId);
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('finishes a disconnected network reload and replays the persisted v2 result', async () => {
  const { directory, workspace } = await makeWorkspace('kairos-reload-network-disconnect-');
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'load before disconnect' });
  const gate = deferred();
  let fixture: SlashFixture | undefined;
  try {
    const inner = new CountingWorkspaceLoader(workspace);
    let calls = 0;
    const loader = {
      load: async () => {
        calls += 1;
        if (calls > 1) await gate.promise;
        return inner.load();
      },
    };
    fixture = await startSlashFixture(directory, {
      provider,
      workspaceDirectory: workspace,
      workspaceResourceLoader: loader,
    });
    const threadId = await createSlashThread(fixture, 'network-reload-disconnect-thread');
    const first = await sendSlashMessage(
      fixture,
      threadId,
      'load before disconnected reload',
      'network-reload-disconnect-first-input',
    );
    await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    await writeFile(join(workspace, 'AGENTS.md'), 'AGENTS disconnected v2 marker');
    const countsBefore = tableCounts(fixture, threadId);
    const request = { threadId, clientActionId: 'network-reload-disconnect' };
    const controller = new AbortController();
    const disconnected = fixture.clients.workspace.reloadResources(request, {
      signal: controller.signal,
    });
    await vi.waitFor(
      () => {
        expect(calls).toBe(2);
      },
      { timeout: 10_000 },
    );
    controller.abort();
    await expect(disconnected).rejects.toMatchObject({ code: Code.Canceled });
    gate.resolve();
    await vi.waitFor(
      () => {
        const row = fixture?.database
          .prepare('SELECT response_json FROM client_actions WHERE client_action_id = ?')
          .get(request.clientActionId);
        expect(row).toMatchObject({ response_json: expect.stringContaining('"completed"') });
      },
      { timeout: 10_000 },
    );
    const replayed = await fixture.clients.workspace.reloadResources(request);
    expect(replayed).toMatchObject({
      changed: true,
      resources: ['.agents/skills/alpha/SKILL.md', 'AGENTS.md'],
      updated: ['AGENTS.md'],
      added: [],
      removed: [],
    });
    expect(calls).toBe(2);
    expect(tableCounts(fixture, threadId)).toEqual({
      ...countsBefore,
      events: countsBefore.events + 1,
    });
    expect(provider.requests).toHaveLength(1);
  } finally {
    gate.resolve();
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('recovers an accepted reload as terminal interrupted after an abnormal Server restart', async () => {
  const { directory, workspace } = await makeWorkspace('kairos-reload-network-restart-');
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'load before restart' });
  const gate = deferred();
  let fixture: SlashFixture | undefined;
  let crashed = false;
  try {
    const inner = new CountingWorkspaceLoader(workspace);
    let calls = 0;
    const loader = {
      load: async () => {
        calls += 1;
        if (calls > 1) await gate.promise;
        return inner.load();
      },
    };
    fixture = await startSlashFixture(directory, {
      provider,
      workspaceDirectory: workspace,
      workspaceResourceLoader: loader,
    });
    const threadId = await createSlashThread(fixture, 'network-reload-restart-thread');
    const first = await sendSlashMessage(
      fixture,
      threadId,
      'load before interrupted reload',
      'network-reload-restart-first-input',
    );
    await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    const countsBeforeReload = tableCounts(fixture, threadId);
    await writeFile(join(workspace, 'AGENTS.md'), 'AGENTS restarted v2 marker');
    const request = { threadId, clientActionId: 'network-reload-restart-interrupted' };
    const running = fixture.clients.workspace.reloadResources(request);
    await vi.waitFor(
      () => {
        expect(calls).toBe(2);
        const row = fixture?.database
          .prepare('SELECT response_json FROM client_actions WHERE client_action_id = ?')
          .get(request.clientActionId);
        expect(JSON.parse(String(row?.response_json))).toMatchObject({
          status: 'running',
          operationId: expect.any(String),
          envId: expect.any(String),
          pwd: expect.any(String),
        });
      },
      { timeout: 10_000 },
    );
    crashed = true;
    await crashSlashFixture(fixture);
    const transportFailure = await expectSlashError(running, Code.Aborted);
    expect(slashErrorTerminal(transportFailure)).toBeUndefined();

    fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
    const interrupted = await expectSlashError(
      fixture.clients.workspace.reloadResources(request),
      Code.FailedPrecondition,
    );
    expect(slashErrorTerminal(interrupted)).toBe(true);
    expect(
      fixture.database
        .prepare('SELECT response_json FROM client_actions WHERE client_action_id = ?')
        .get(request.clientActionId),
    ).toEqual({
      response_json: expect.stringContaining('"status":"interrupted"'),
    });
    expect(tableCounts(fixture, threadId)).toEqual(countsBeforeReload);
    const retried = await fixture.clients.workspace.reloadResources({
      threadId,
      clientActionId: 'network-reload-restart-new-action',
    });
    expect(retried).toMatchObject({
      changed: true,
      resources: ['.agents/skills/alpha/SKILL.md', 'AGENTS.md'],
      updated: ['AGENTS.md'],
      added: [],
      removed: [],
    });
    expect(provider.requests).toHaveLength(1);
  } finally {
    if (!crashed) gate.resolve();
    if (fixture) await closeSlashFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it.each(['preparing', 'prepared'] as const)(
  'continues a %s request with a new request ID and the current code and workspace spec',
  async (evidence) => {
    const { directory, workspace } = await makeWorkspace(
      `kairos-reload-network-continue-${evidence}-`,
    );
    const provider = new ControlledSlashProvider();
    const answer = `continued ${evidence} with code v2`;
    provider.enqueue({ kind: 'normal', content: answer });
    const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
    try {
      const threadId = await createSlashThread(fixture, `create-continue-${evidence}`);
      const requestId = `network-old-${evidence}-request`;
      const seed = await seedInterruptedRequest(fixture, threadId, requestId, evidence);
      expect(systemText(seed.prepared.request)).toContain('code v1 base prompt');
      expect(seed.prepared.request.tools.map((tool) => tool.name)).toEqual(['code_v1_only_tool']);
      const before = requestAudit(fixture, requestId);
      const inputBefore = modelInputAudit(fixture, threadId);
      const countsBefore = tableCounts(fixture, threadId);
      await writeV2Workspace(workspace);

      const request = { threadId, clientActionId: `network-reload-continue-${evidence}` };
      const reloaded = await fixture.clients.workspace.reloadResources(request);
      expect(reloaded).toMatchObject({
        changed: true,
        runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(reloaded.runtimeChanged).toBeUndefined();
      expect(provider.requests).toHaveLength(0);
      expect(currentRequestId(fixture, seed.runId)).toBeNull();
      expect(requestAudit(fixture, requestId)).toEqual({
        ...before,
        status: 'cancelled',
        error_code: 'cancelled',
        error_message: 'Invalidated by workspace resource reload before Provider dispatch.',
        updated_at: expect.any(String),
      });
      expect(modelInputAudit(fixture, threadId)).toEqual(inputBefore);
      expect(tableCounts(fixture, threadId)).toEqual({
        ...countsBefore,
        events: countsBefore.events + 1,
      });
      expect(await fixture.clients.workspace.reloadResources(request)).toEqual(reloaded);
      expect(provider.requests).toHaveLength(0);
      expect(requestAudit(fixture, requestId)).toEqual({
        ...before,
        status: 'cancelled',
        error_code: 'cancelled',
        error_message: 'Invalidated by workspace resource reload before Provider dispatch.',
        updated_at: expect.any(String),
      });

      await fixture.clients.runs.continueRun({
        clientActionId: `network-continue-${evidence}`,
        threadId,
        runId: seed.runId,
      });
      await waitSlashRun(fixture, threadId, seed.runId, RunStatus.COMPLETED);
      expect(provider.byKind('normal')).toHaveLength(1);
      const actual = provider.byKind('normal')[0]?.request;
      if (!actual) throw new Error('The continued Provider request is missing.');
      const instructions = systemText(actual);
      expect(instructions).toContain('You are Kairos, a personal coding and task agent.');
      expect(instructions).toContain('AGENTS v2 marker');
      expect(instructions).toContain('Skill beta v2 marker');
      expect(instructions).not.toContain('code v1 base prompt');
      expect(instructions).not.toContain('workspace v1 instructions');
      expect(instructions).not.toContain('AGENTS v1 marker');
      expect(instructions).not.toContain('Skill alpha v1 marker');
      expect(actual.tools.map((tool) => tool.name)).toContain('bash');
      expect(actual.tools.map((tool) => tool.name)).not.toContain('code_v1_only_tool');
      expect(actual.tools).not.toEqual(seed.prepared.request.tools);
      expect(actual.messages.filter((message) => message.content === seed.text)).toHaveLength(1);
      expect(runtimeSpecFingerprintFromRequest(actual)).toBe(reloaded.runtimeFingerprint);

      const records = z
        .array(
          z.object({
            request_id: z.string(),
            status: z.string(),
            pending_context_seqs_json: z.string(),
            context_message_seqs_json: z.string(),
            request_fingerprint: z.string().nullable(),
          }),
        )
        .parse(
          fixture.database
            .prepare(
              `SELECT request_id, status, pending_context_seqs_json, context_message_seqs_json,
                      request_fingerprint
               FROM model_request_records WHERE thread_id = ? ORDER BY rowid`,
            )
            .all(threadId),
        );
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ request_id: requestId, status: 'cancelled' });
      const rebuilt = records[1];
      expect(rebuilt).toMatchObject({
        status: 'completed',
        pending_context_seqs_json: '[]',
        context_message_seqs_json: JSON.stringify([seed.user.seq]),
      });
      expect(rebuilt?.request_id).not.toBe(requestId);
      expect(rebuilt?.request_fingerprint).not.toBe(before.request_fingerprint);
      expect(records[0]?.pending_context_seqs_json).toBe(JSON.stringify([seed.user.seq]));
      expect(records[0]?.context_message_seqs_json).toBe(JSON.stringify([seed.user.seq]));
      if (!rebuilt) throw new Error('The rebuilt request record is missing.');
      expect(
        z
          .array(z.object({ event_type: z.string() }))
          .parse(
            fixture.database
              .prepare(
                'SELECT event_type FROM context_events WHERE payload_json = ? ORDER BY event_seq',
              )
              .all(JSON.stringify({ request_id: rebuilt.request_id })),
          ),
      ).toEqual([
        { event_type: 'model_request_prepared' },
        { event_type: 'model_request_dispatched' },
      ]);
      expect(
        z
          .array(z.object({ seq: z.number(), role: z.string(), content: z.string() }))
          .parse(
            fixture.database
              .prepare(
                'SELECT seq, role, content FROM context_messages WHERE thread_id = ? ORDER BY seq',
              )
              .all(threadId),
          ),
      ).toEqual([
        { seq: seed.user.seq, role: 'user', content: seed.text },
        { seq: seed.user.seq + 1, role: 'assistant', content: answer },
      ]);
      expect(
        z
          .array(
            z.object({ input_id: z.string(), status: z.string(), consumed_run_id: z.string() }),
          )
          .parse(
            fixture.database
              .prepare('SELECT input_id, status, consumed_run_id FROM inputs WHERE thread_id = ?')
              .all(threadId),
          ),
      ).toEqual([{ input_id: seed.inputId, status: 'consumed', consumed_run_id: seed.runId }]);
      expect(tableCounts(fixture, threadId)).toMatchObject({
        inputs: 1,
        runs: 1,
        context: 2,
        recaps: 0,
      });
    } finally {
      await cleanUp(directory, fixture);
    }
  },
  30_000,
);

it.each(['dispatched', 'legacy'] as const)(
  'retains a %s ready request as unknown and does not retry Provider after reload or Continue',
  async (evidence) => {
    const { directory, workspace } = await makeWorkspace(
      `kairos-reload-network-unknown-${evidence}-`,
    );
    const provider = new ControlledSlashProvider();
    const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
    try {
      const threadId = await createSlashThread(fixture, `create-unknown-${evidence}`);
      const requestId = `network-old-${evidence}-request`;
      const seed = await seedInterruptedRequest(fixture, threadId, requestId, evidence);
      const before = requestAudit(fixture, requestId);
      const inputBefore = modelInputAudit(fixture, threadId);
      const countsBefore = tableCounts(fixture, threadId);
      await writeV2Workspace(workspace);

      const request = { threadId, clientActionId: `network-reload-unknown-${evidence}` };
      const reloaded = await fixture.clients.workspace.reloadResources(request);
      expect(reloaded.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(reloaded.runtimeChanged).toBeUndefined();
      expect(currentRequestId(fixture, seed.runId)).toBe(requestId);
      expect(requestAudit(fixture, requestId)).toEqual(before);
      expect(modelInputAudit(fixture, threadId)).toEqual(inputBefore);
      expect(tableCounts(fixture, threadId)).toEqual({
        ...countsBefore,
        events: countsBefore.events + 1,
      });
      expect(provider.requests).toHaveLength(0);
      expect(await fixture.clients.workspace.reloadResources(request)).toEqual(reloaded);
      expect(provider.requests).toHaveLength(0);

      await fixture.clients.runs.continueRun({
        clientActionId: `network-continue-unknown-${evidence}`,
        threadId,
        runId: seed.runId,
      });
      await waitSlashRun(fixture, threadId, seed.runId, RunStatus.FAILED);
      expect(provider.requests).toHaveLength(0);
      expect(currentRequestId(fixture, seed.runId)).toBe(requestId);
      expect(requestAudit(fixture, requestId)).toEqual(before);
      expect(
        fixture.database
          .prepare('SELECT status, error_code FROM runs WHERE run_id = ?')
          .get(seed.runId),
      ).toEqual({ status: 'failed', error_code: 'action_conflict' });
      expect(tableCounts(fixture, threadId)).toMatchObject({
        inputs: countsBefore.inputs,
        runs: countsBefore.runs,
        context: countsBefore.context,
        recaps: countsBefore.recaps,
      });
    } finally {
      await cleanUp(directory, fixture);
    }
  },
  30_000,
);

it('rolls back request invalidation and the v2 snapshot when the reload receipt cannot commit', async () => {
  const { directory, workspace } = await makeWorkspace('kairos-reload-network-atomic-');
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'old snapshot survives failed commit' });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'create-atomic-reload');
    const requestId = 'network-old-atomic-request';
    const seed = await seedInterruptedRequest(fixture, threadId, requestId, 'prepared');
    const before = requestAudit(fixture, requestId);
    const inputBefore = modelInputAudit(fixture, threadId);
    const countsBefore = tableCounts(fixture, threadId);
    await writeV2Workspace(workspace);
    fixture.database.exec(`
      CREATE TRIGGER reject_network_reload_completion BEFORE UPDATE OF response_json ON client_actions
      WHEN OLD.method = 'ReloadEnvironmentResources' AND NEW.response_json LIKE '%"completed"%'
      BEGIN SELECT RAISE(ABORT, 'injected network reload receipt failure'); END;
    `);
    const request = { threadId, clientActionId: 'network-reload-atomic-failure' };
    const failure = await expectSlashError(
      fixture.clients.workspace.reloadResources(request),
      Code.Internal,
    );
    expect(slashErrorTerminal(failure)).toBe(true);
    expect(currentRequestId(fixture, seed.runId)).toBe(requestId);
    expect(requestAudit(fixture, requestId)).toEqual(before);
    expect(modelInputAudit(fixture, threadId)).toEqual(inputBefore);
    expect(tableCounts(fixture, threadId)).toEqual(countsBefore);
    expect(provider.requests).toHaveLength(0);
    const loader = fixture.workspaceResourceLoader as CountingWorkspaceLoader;
    const loadsAfterFailure = loader.calls;
    const replayed = await expectSlashError(
      fixture.clients.workspace.reloadResources(request),
      Code.Internal,
    );
    expect(slashErrorTerminal(replayed)).toBe(true);
    expect(replayed.message).toBe(failure.message);
    expect(loader.calls).toBe(loadsAfterFailure);
    expect(requestAudit(fixture, requestId)).toEqual(before);
    expect(provider.requests).toHaveLength(0);

    const next = await sendSlashMessage(
      fixture,
      threadId,
      'verify old snapshot after failed commit',
      'network-after-atomic-failure-input',
    );
    await waitSlashRun(fixture, threadId, next.runId, RunStatus.COMPLETED);
    expect(provider.byKind('normal')).toHaveLength(1);
    const instructions = systemText(
      provider.byKind('normal')[0]?.request ?? { messages: [], tools: [] },
    );
    expect(instructions).toContain('AGENTS v1 marker');
    expect(instructions).toContain('Skill alpha v1 marker');
    expect(instructions).not.toContain('AGENTS v2 marker');
    expect(instructions).not.toContain('Skill beta v2 marker');
    expect(currentRequestId(fixture, seed.runId)).toBe(requestId);
    expect(requestAudit(fixture, requestId)).toEqual(before);
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('preserves completed and manual compact audits and the periodic Recap v1 prefix after reload', async () => {
  const { directory, workspace } = await makeWorkspace('kairos-reload-network-audit-');
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'first v1 answer' });
  provider.enqueue({ kind: 'recap', content: 'manual v1 user recap' });
  provider.enqueue({ kind: 'recap', content: 'manual v1 answer recap' });
  provider.enqueue({ kind: 'normal', content: 'second v1 answer' });
  let fixture = await startSlashFixture(directory, {
    provider,
    workspaceDirectory: workspace,
    periodicRecap: { messageThreshold: 1000, responseWindowMs: 600_000 },
  });
  try {
    const threadId = await createSlashThread(fixture, 'create-reload-audit');
    const first = await sendSlashMessage(
      fixture,
      threadId,
      'first v1 audit source',
      'network-first-v1-audit-input',
    );
    await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    const compacted = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-manual-compact-before-reload',
    });
    expect(compacted.status).toBe(CompactContextStatus.CHANGED);
    expect(compacted.recapIds).toHaveLength(2);
    const second = await sendSlashMessage(
      fixture,
      threadId,
      'second v1 audit source',
      'network-second-v1-audit-input',
    );
    await waitSlashRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    expect(provider.byKind('normal')).toHaveLength(2);
    expect(provider.byKind('recap')).toHaveLength(2);

    const readAudit = () => ({
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .parse(
          fixture.database
            .prepare('SELECT * FROM model_request_records WHERE thread_id = ? ORDER BY rowid')
            .all(threadId),
        ),
      manual: z
        .array(z.record(z.string(), z.unknown()))
        .parse(
          fixture.database
            .prepare('SELECT * FROM manual_compact_operations WHERE thread_id = ? ORDER BY rowid')
            .all(threadId),
        ),
      recaps: z
        .array(z.record(z.string(), z.unknown()))
        .parse(
          fixture.database
            .prepare('SELECT * FROM recaps WHERE thread_id = ? ORDER BY rowid')
            .all(threadId),
        ),
      context: z
        .array(z.record(z.string(), z.unknown()))
        .parse(
          fixture.database
            .prepare('SELECT * FROM context_messages WHERE thread_id = ? ORDER BY seq')
            .all(threadId),
        ),
      input: modelInputAudit(fixture, threadId),
    });
    const before = readAudit();
    await writeV2Workspace(workspace);
    const request = { threadId, clientActionId: 'network-reload-preserve-audit' };
    const reloaded = await fixture.clients.workspace.reloadResources(request);
    expect(reloaded).toMatchObject({
      changed: true,
      runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeChanged: true,
    });
    expect(readAudit()).toEqual(before);
    expect(provider.requests).toHaveLength(4);
    expect(await fixture.clients.workspace.reloadResources(request)).toEqual(reloaded);
    expect(readAudit()).toEqual(before);
    expect(provider.requests).toHaveLength(4);
    await closeSlashFixture(fixture);

    const restartedProvider = new ControlledSlashProvider();
    restartedProvider.enqueue({ kind: 'recap', content: 'periodic v1 history recap' });
    fixture = await startSlashFixture(directory, {
      provider: restartedProvider,
      workspaceDirectory: workspace,
      periodicRecap: { messageThreshold: 2, responseWindowMs: 600_000 },
    });
    await waitSlashRequests(restartedProvider, 'recap', 1);
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare('SELECT COUNT(*) AS count FROM recaps WHERE thread_id = ?')
          .get(threadId),
      ).toEqual({ count: 3 });
    });
    const oldSecond = provider.byKind('normal')[1]?.request;
    const periodic = restartedProvider.byKind('recap')[0]?.request;
    if (!oldSecond || !periodic) throw new Error('The v1 or periodic Recap request is missing.');
    expect(periodic.messages.slice(0, oldSecond.messages.length)).toEqual(oldSecond.messages);
    expect(periodic.tools).toEqual(oldSecond.tools);
    expect(periodic.messages[oldSecond.messages.length]).toEqual({
      role: 'assistant',
      content: 'second v1 answer',
    });
    expect(periodic.messages.at(-1)?.role).toBe('user');
    expect(periodic.messages.at(-1)?.content).toContain('Kairos internal Recap operation;');
    expect(systemText(periodic)).toBe(systemText(oldSecond));
    expect(systemText(periodic)).toContain('AGENTS v1 marker');
    expect(systemText(periodic)).toContain('Skill alpha v1 marker');
    expect(systemText(periodic)).not.toContain('AGENTS v2 marker');
    expect(systemText(periodic)).not.toContain('Skill beta v2 marker');
    expect(restartedProvider.byKind('normal')).toHaveLength(0);

    const after = readAudit();
    expect(after.requests).toEqual(before.requests);
    expect(after.manual).toEqual(before.manual);
    expect(after.context).toEqual(before.context);
    expect(after.input).toEqual(before.input);
    expect(after.recaps.slice(0, 2)).toEqual(before.recaps);
    expect(after.recaps[2]).toMatchObject({
      content: 'periodic v1 history recap',
      validity: 'valid',
      source_message_seqs: '[3,4]',
    });
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);
