import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest, ModelUsage } from '@kairos/agent-core';
import { MessageSource, RunExecutionMode, RunStatus } from '@kairos/contracts';
import { expect, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { closeFixture, type Fixture, sendMessage, startFixture } from './delegation-fixture.js';
import type { RealModelConfig } from './real-model-config.js';

const terminalStatuses = [
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
];

type UsageSink = (usage: ModelUsage) => void;

class ObservedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly usages: Array<{ requestIndex: number; usage: ModelUsage }> = [];
  readonly source: OpenAICompatibleProvider;

  constructor(
    config: RealModelConfig,
    private readonly addUsage: UsageSink,
  ) {
    this.source = new OpenAICompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.modelId,
      contextWindow: config.contextWindow,
      outputReserve: config.outputReserve,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const requestIndex = this.requests.push(structuredClone(request)) - 1;
    for await (const event of this.source.stream(request, signal)) {
      if ((event.type === 'response' || event.type === 'stream_interrupted') && event.usage) {
        this.usages.push({ requestIndex, usage: event.usage });
        this.addUsage(event.usage);
      }
      yield event;
    }
  }
}

interface ThreadDelegationEvidence {
  version: 1;
  status: 'passed' | 'failed';
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  command: string;
  commit: string;
  temporary_data_directory: 'fresh_empty_mkdtemp';
  provider_requests: Array<Record<string, unknown>>;
  calls?: Record<string, unknown>;
  thread_read?: Record<string, unknown>;
  checks: string[];
  usage: Required<ModelUsage>;
  failures: string[];
  unverified: string[];
  cleanup?: { server_closed: boolean; temporary_directory_removed: boolean };
}

function providerRequestEvidence(provider: ObservedProvider): Array<Record<string, unknown>> {
  return provider.requests.map((request, index) => {
    const last = request.messages.at(-1);
    return {
      index,
      last_message: last ? { role: last.role, content: last.content } : null,
      tools: request.tools.map((tool) => tool.name),
      usage: provider.usages.find((candidate) => candidate.requestIndex === index)?.usage ?? null,
    };
  });
}

function safeError(error: unknown): string {
  const secret = process.env.KAIROS_MODEL_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return (secret ? message.replaceAll(secret, '[redacted]') : message)
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

async function writeThreadDelegationEvidence(evidence: ThreadDelegationEvidence): Promise<void> {
  const path = process.env.KAIROS_THREAD_DELEGATION_EVIDENCE;
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

interface ToolResultRow {
  runId: string;
  toolCallId: string;
  toolName: string;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function parsedTool(row: ToolResultRow): Record<string, unknown> {
  const value: unknown = JSON.parse(row.content);
  if (!isRecord(value)) throw new Error(`${row.toolName} returned a non-object result.`);
  return value;
}

function toolResults(
  fixture: Fixture,
  threadId: string,
  runId: string,
  toolName: string,
): ToolResultRow[] {
  const rows = fixture.database
    .prepare(
      `SELECT run_id, tool_call_id, tool_name, content FROM context_messages
       WHERE thread_id = ? AND run_id = ? AND role = 'tool' AND tool_name = ?
       ORDER BY seq`,
    )
    .all(threadId, runId, toolName);
  const results: ToolResultRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    results.push({
      runId: requiredString(row.run_id, 'Tool result Run ID'),
      toolCallId: requiredString(row.tool_call_id, 'Tool call ID'),
      toolName: requiredString(row.tool_name, 'Tool name'),
      content: requiredString(row.content, 'Tool result content'),
    });
  }
  return results;
}

async function runForTool(
  fixture: Fixture,
  threadId: string,
  actionId: string,
  prompt: string,
  toolName: string,
): Promise<{ runId: string; result: ToolResultRow }> {
  let nextPrompt = prompt;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { runId } = await sendMessage(fixture, threadId, nextPrompt, `${actionId}-${attempt}`);
    await waitRun(fixture, threadId, runId, RunStatus.COMPLETED);
    const result = toolResults(fixture, threadId, runId, toolName)[0];
    if (result) return { runId, result };
    nextPrompt = `${prompt}\nThe previous response did not call ${toolName}. Call ${toolName} now with the requested arguments.`;
  }
  throw new Error(`Model behavior: ${toolName} was not called after two attempts.`);
}

async function runSnapshot(fixture: Fixture, threadId: string, runId: string) {
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
  if (!run) throw new Error(`Run ${runId} is missing from Thread ${threadId}.`);
  return run;
}

async function waitRun(
  fixture: Fixture,
  threadId: string,
  runId: string,
  status: RunStatus,
  timeout = 180_000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const run = await runSnapshot(fixture, threadId, runId);
      expect(terminalStatuses).toContain(run.status);
    },
    { timeout },
  );
  const run = await runSnapshot(fixture, threadId, runId);
  expect(run.status).toBe(status);
}

function interactionRow(fixture: Fixture, toolCallId: string): Record<string, unknown> {
  const row: unknown = fixture.database
    .prepare(
      `SELECT source_tool_call_id, kind, execution_mode, source_run_id, target_thread_id,
              target_agent_id, prompt, consumed_run_id, status, response_message_seq, error_code
       FROM interactions WHERE source_tool_call_id = ?`,
    )
    .get(toolCallId);
  if (!isRecord(row)) throw new Error(`Interaction ${toolCallId} is missing.`);
  return row;
}

function toolCallIdForSource(
  fixture: Fixture,
  sourceRunId: string,
  kind: 'thread_call' | 'subagent',
): string {
  const row: unknown = fixture.database
    .prepare('SELECT source_tool_call_id FROM interactions WHERE source_run_id = ? AND kind = ?')
    .get(sourceRunId, kind);
  if (!isRecord(row)) throw new Error(`${kind} interaction for Run ${sourceRunId} is missing.`);
  return requiredString(row.source_tool_call_id, 'Source tool call ID');
}

async function waitInteraction(
  fixture: Fixture,
  toolCallId: string,
  status: string,
): Promise<Record<string, unknown>> {
  await vi.waitFor(
    () => {
      expect(interactionRow(fixture, toolCallId).status).toBe(status);
    },
    { timeout: 180_000 },
  );
  return interactionRow(fixture, toolCallId);
}

function deliveryRow(fixture: Fixture, toolCallId: string): Record<string, unknown> {
  const row: unknown = fixture.database
    .prepare(
      `SELECT source_tool_call_id, content, context_message_seq, run_id, status
       FROM interaction_deliveries WHERE source_tool_call_id = ?`,
    )
    .get(toolCallId);
  if (!isRecord(row)) throw new Error(`Delivery for interaction ${toolCallId} is missing.`);
  return row;
}

async function waitDelivered(
  fixture: Fixture,
  mainId: string,
  toolCallId: string,
  source: 'thread_response' | 'subagent_response',
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(deliveryRow(fixture, toolCallId).status).toBe('consumed');
    },
    { timeout: 180_000 },
  );
  const delivery = deliveryRow(fixture, toolCallId);
  const consumedRunId = requiredString(delivery.run_id, 'Delivery consumption Run ID');
  if (typeof delivery.context_message_seq !== 'number') {
    throw new Error('Delivery Context sequence is missing.');
  }
  await waitRun(fixture, mainId, consumedRunId, RunStatus.COMPLETED);
  const deliveredContext: unknown = fixture.database
    .prepare(
      `SELECT seq FROM context_messages
       WHERE seq = ? AND thread_id = ? AND run_id = ? AND role = 'user' AND source = ?
         AND delegation_source_thread_id = ? AND delegation_source_agent_id = 'thread'
         AND source_tool_call_id = ?`,
    )
    .get(delivery.context_message_seq, mainId, consumedRunId, source, mainId, toolCallId);
  if (!isRecord(deliveredContext) || typeof deliveredContext.seq !== 'number') {
    throw new Error(`Delivered Context for interaction ${toolCallId} is missing.`);
  }
  const assistant: unknown = fixture.database
    .prepare(
      `SELECT content FROM context_messages
       WHERE thread_id = ? AND run_id = ? AND role = 'assistant' AND content <> '' AND seq > ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(mainId, consumedRunId, deliveredContext.seq);
  expect(isRecord(assistant) && typeof assistant.content === 'string').toBe(true);
  const snapshot = await fixture.clients.thread.getThread({ threadId: mainId });
  const message = snapshot.snapshot?.messages.find(
    (candidate) =>
      candidate.delegation?.sourceThreadId === mainId &&
      candidate.delegation.sourceAgentId === 'thread' &&
      candidate.delegation.sourceToolCallId === toolCallId,
  );
  expect(message?.source).toBe(
    source === 'thread_response' ? MessageSource.THREAD_RESPONSE : MessageSource.SUBAGENT_RESPONSE,
  );
}

async function waitFile(path: string, expected: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await readFile(path, 'utf8').catch(() => undefined)).toBe(expected);
    },
    { timeout: 180_000 },
  );
}

function responseText(fixture: Fixture, toolCallId: string): string {
  const row: unknown = fixture.database
    .prepare(
      `SELECT m.content FROM interactions i
       JOIN context_messages m ON m.seq = i.response_message_seq
       WHERE i.source_tool_call_id = ?`,
    )
    .get(toolCallId);
  if (!isRecord(row)) throw new Error(`Response for interaction ${toolCallId} is missing.`);
  return requiredString(row.content, 'Interaction response');
}

function childRun(fixture: Fixture, parentRunId: string): Record<string, unknown> {
  const rows = fixture.database
    .prepare(
      `SELECT run_id, agent_id, status, execution_mode FROM runs
       WHERE parent_run_id = ? ORDER BY created_at, run_id`,
    )
    .all(parentRunId);
  expect(rows).toHaveLength(1);
  const row: unknown = rows[0];
  if (!isRecord(row)) throw new Error(`Child Run for ${parentRunId} is missing.`);
  return row;
}

export async function runThreadDelegationDemo(
  config: RealModelConfig,
  addUsage: UsageSink,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-thread-delegation-'));
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const trackUsage = (next: ModelUsage): void => {
    usage.input_tokens += next.input_tokens;
    usage.output_tokens += next.output_tokens;
    usage.total_tokens += next.total_tokens ?? next.input_tokens + next.output_tokens;
    addUsage(next);
  };
  const provider = new ObservedProvider(config, trackUsage);
  let evidence: ThreadDelegationEvidence | undefined;
  const fixture = await startFixture(directory, {
    provider,
    contextWindowTokens: config.contextWindow,
    outputReserveTokens: config.outputReserve,
    countTokens: (request) => provider.source.estimateRequestTokens(request),
  });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    expect(mainId).not.toBe('');
    const title = `REQ05 real Thread ${Date.now()}`;
    const internalCommand = `node -e "console.log('REQ05_INTERNAL_' + require('node:crypto').randomUUID())"`;
    const firstPrompt = `Call bash exactly once with cwd ${directory}, timeoutSeconds 30, and this exact command:\n${internalCommand}\nAfter bash returns, reply exactly THREAD_RESPONSE_ONE. Do not call any other tool.`;
    const firstCall = await runForTool(
      fixture,
      mainId,
      'real-thread-call-create',
      `Call thread_call exactly once without thread_id, with title ${JSON.stringify(title)}, mode follow_up, and this exact first prompt:\n${firstPrompt}\nThis single call must create the task Thread and submit its first prompt. Do not call thread_create, thread_read or any other tool.`,
      'thread_call',
    );
    const firstReceipt = parsedTool(firstCall.result);
    const taskId = requiredString(firstReceipt.thread_id, 'Created task Thread ID');
    const firstToolCallId = requiredString(firstReceipt.tool_call_id, 'First interaction ID');
    expect(firstReceipt).toMatchObject({ thread_id: taskId, status: 'accepted' });
    expect(
      (await fixture.clients.thread.getThread({ threadId: taskId })).snapshot?.thread?.title,
    ).toBe(title);
    const firstInteraction = await vi.waitFor(
      async () => {
        const row = interactionRow(fixture, firstToolCallId);
        expect(row.consumed_run_id).not.toBeNull();
        return row;
      },
      { timeout: 180_000 },
    );
    const firstTargetRunId = requiredString(
      firstInteraction.consumed_run_id,
      'First target consumption Run ID',
    );
    const firstTargetRun = await runSnapshot(fixture, taskId, firstTargetRunId);
    expect(firstTargetRun.executionMode).toBe(RunExecutionMode.BACKGROUND);

    await waitDelivered(fixture, mainId, firstToolCallId, 'thread_response');
    await waitInteraction(fixture, firstToolCallId, 'completed');
    const firstResponse = responseText(fixture, firstToolCallId);
    expect(firstResponse).toContain('THREAD_RESPONSE_ONE');
    const targetBash = toolResults(fixture, taskId, firstTargetRunId, 'bash');
    expect(targetBash).toHaveLength(1);
    const internalMarker = targetBash[0]?.content.match(/REQ05_INTERNAL_[0-9a-f-]{36}/)?.[0];
    expect(internalMarker).toBeDefined();

    const read = await runForTool(
      fixture,
      mainId,
      'real-thread-read-one',
      `Call thread_read exactly once with tool_call_id ${firstToolCallId} and wait_ms 30000. Report its actual result. Do not call any other tool.`,
      'thread_read',
    );
    expect(parsedTool(read.result)).toMatchObject({
      tool_call_id: firstToolCallId,
      status: 'completed',
      response: firstResponse,
      timed_out: false,
    });

    const secondPrompt =
      'Reply exactly THREAD_RESPONSE_TWO. This is a later Run in the same Thread; use the existing conversation and do not call tools.';
    const secondCall = await runForTool(
      fixture,
      mainId,
      'real-thread-call-two',
      `Call thread_call exactly once with thread_id ${taskId}, mode follow_up, and this exact prompt:\n${secondPrompt}\nDo not call any other tool.`,
      'thread_call',
    );
    const secondReceipt = parsedTool(secondCall.result);
    const secondToolCallId = requiredString(secondReceipt.tool_call_id, 'Second interaction ID');
    expect(secondToolCallId).not.toBe(firstToolCallId);
    expect(secondReceipt).toMatchObject({ thread_id: taskId, status: 'accepted' });
    await waitDelivered(fixture, mainId, secondToolCallId, 'thread_response');
    const secondInteraction = await waitInteraction(fixture, secondToolCallId, 'completed');
    const secondTargetRunId = requiredString(
      secondInteraction.consumed_run_id,
      'Second target consumption Run ID',
    );
    expect(secondTargetRunId).not.toBe(firstTargetRunId);
    expect(secondInteraction.target_thread_id).toBe(taskId);
    expect(responseText(fixture, secondToolCallId)).toContain('THREAD_RESPONSE_TWO');

    const firstTargetPrompt = requiredString(firstInteraction.prompt, 'First target prompt');
    const secondTargetPrompt = requiredString(secondInteraction.prompt, 'Second target prompt');
    const secondTargetRequest = provider.requests.find(
      (request) =>
        !request.tools.some((tool) => tool.name === 'thread_call') &&
        request.messages.at(-1)?.role === 'user' &&
        request.messages.at(-1)?.content === secondTargetPrompt,
    );
    if (!secondTargetRequest) {
      throw new Error('The second target request does not contain its recorded prompt.');
    }
    const secondTargetContents = secondTargetRequest.messages.map((message) => message.content);
    expect(secondTargetContents).toContain(firstTargetPrompt);
    expect(secondTargetContents).toContain(firstResponse);
    expect(secondTargetContents).toContain(secondTargetPrompt);

    const mainRequests = provider.requests.filter((request) =>
      request.tools.some((tool) => tool.name === 'thread_call'),
    );
    expect(mainRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(mainRequests)).not.toContain(internalMarker);
    const mainContext = await fixture.clients.context.readContext({
      threadId: mainId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 500,
    });
    const serializedMainContext = JSON.stringify(mainContext.messages, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serializedMainContext).not.toContain(internalMarker);
    expect(
      mainRequests.every((request) => request.tools.every((tool) => tool.name !== 'thread_create')),
    ).toBe(true);
    expect(toolResults(fixture, mainId, firstCall.runId, 'thread_create')).toHaveLength(0);
    expect(
      toolResults(fixture, mainId, firstCall.runId, 'thread_call').filter(
        (row) => row.toolCallId === firstCall.result.toolCallId,
      ),
    ).toHaveLength(1);
    evidence = {
      version: 1,
      status: 'passed',
      model: { providerId: 'openai-compatible', modelId: config.modelId },
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      command:
        process.env.KAIROS_THREAD_DELEGATION_COMMAND ??
        'bash scripts/real-model.sh (focused real Thread delegation)',
      commit: process.env.KAIROS_ACCEPTANCE_COMMIT ?? '',
      temporary_data_directory: 'fresh_empty_mkdtemp',
      provider_requests: providerRequestEvidence(provider),
      calls: {
        first: {
          receipt: firstReceipt,
          delegation: {
            source_thread_id: mainId,
            source_agent_id: 'thread',
            source_tool_call_id: firstToolCallId,
          },
          target_thread_id: taskId,
          target_run_id: firstTargetRunId,
          interaction: interactionRow(fixture, firstToolCallId),
          response: firstResponse,
        },
        second: {
          receipt: secondReceipt,
          delegation: {
            source_thread_id: mainId,
            source_agent_id: 'thread',
            source_tool_call_id: secondToolCallId,
          },
          target_thread_id: taskId,
          target_run_id: secondTargetRunId,
          interaction: interactionRow(fixture, secondToolCallId),
          response: responseText(fixture, secondToolCallId),
        },
      },
      thread_read: parsedTool(read.result),
      checks: [
        'single_thread_call_created_task_with_first_prompt',
        'first_thread_call_completed_and_delivered',
        'thread_read_returned_first_history_result',
        'second_thread_call_continued_same_thread_with_new_run',
        'target_context_contains_first_prompt_response_and_second_prompt',
        'main_context_excludes_target_internal_marker',
        'thread_create_not_registered_or_called',
      ],
      usage,
      failures: [],
      unverified: [],
    };
  } catch (error) {
    evidence = {
      version: 1,
      status: 'failed',
      model: { providerId: 'openai-compatible', modelId: config.modelId },
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      command:
        process.env.KAIROS_THREAD_DELEGATION_COMMAND ??
        'bash scripts/real-model.sh (focused real Thread delegation)',
      commit: process.env.KAIROS_ACCEPTANCE_COMMIT ?? '',
      temporary_data_directory: 'fresh_empty_mkdtemp',
      provider_requests: providerRequestEvidence(provider),
      checks: [],
      usage,
      failures: [safeError(error)],
      unverified: ['real_thread_delegation'],
    };
    throw error;
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
    if (evidence) {
      evidence.cleanup = { server_closed: true, temporary_directory_removed: true };
      await writeThreadDelegationEvidence(evidence);
    }
  }
}

export async function runSubagentDelegationDemo(
  config: RealModelConfig,
  addUsage: UsageSink,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-subagent-delegation-'));
  const provider = new ObservedProvider(config, addUsage);
  const fixture = await startFixture(directory, {
    provider,
    contextWindowTokens: config.contextWindow,
    outputReserveTokens: config.outputReserve,
    countTokens: (request) => provider.source.estimateRequestTokens(request),
  });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    expect(mainId).not.toBe('');

    const foregroundInternalCommand = `node -e "console.log('REQ05_FOREGROUND_INTERNAL_' + require('node:crypto').randomUUID())"`;
    const foregroundTask = `Call bash exactly once with cwd ${directory}, timeoutSeconds 30, and this exact command:\n${foregroundInternalCommand}\nAfter bash returns, reply exactly FOREGROUND_RESULT. Do not call any other tool.`;
    const foreground = await runForTool(
      fixture,
      mainId,
      'real-subagent-foreground',
      `Call subagent exactly once with mode foreground and this exact task:\n${foregroundTask}\nWait for its result, then reply briefly. Do not call any other tool.`,
      'subagent',
    );
    const foregroundResult = parsedTool(foreground.result);
    const foregroundToolCallId = requiredString(
      foregroundResult.tool_call_id,
      'Foreground interaction ID',
    );
    expect(foregroundResult).toMatchObject({
      status: 'completed',
      result: 'FOREGROUND_RESULT',
    });
    expect(interactionRow(fixture, foregroundToolCallId)).toMatchObject({
      kind: 'subagent',
      execution_mode: 'foreground',
      status: 'completed',
    });
    const foregroundChild = childRun(fixture, foreground.runId);
    expect(foregroundChild).toMatchObject({ execution_mode: 'foreground', status: 'completed' });
    expect(deliveryRowOrUndefined(fixture, foregroundToolCallId)).toBeUndefined();
    const foregroundBash = toolResults(
      fixture,
      mainId,
      requiredString(foregroundChild.run_id, 'Foreground success child Run ID'),
      'bash',
    );
    expect(foregroundBash).toHaveLength(1);
    const foregroundInternalMarker = requiredString(
      foregroundBash[0]?.content.match(/REQ05_FOREGROUND_INTERNAL_[0-9a-f-]{36}/)?.[0],
      'Foreground internal tool marker',
    );

    const foregroundStarted = join(directory, 'foreground-cancel-started.txt');
    const foregroundFinished = join(directory, 'foreground-cancel-finished.txt');
    const foregroundCancelTask = `Call bash exactly once with cwd ${directory}, timeoutSeconds 60, and this exact command:\nprintf started > ${foregroundStarted}; sleep 30; printf finished > ${foregroundFinished}\nDo not call any other tool.`;
    const foregroundCancel = await sendMessage(
      fixture,
      mainId,
      `Call subagent exactly once with mode foreground and this exact task:\n${foregroundCancelTask}\nWait for the foreground result. Do not call any other tool.`,
      'real-subagent-foreground-cancel',
    );
    await waitFile(foregroundStarted, 'started');
    const foregroundCancelChild = childRun(fixture, foregroundCancel.runId);
    expect(foregroundCancelChild.execution_mode).toBe('foreground');
    const foregroundCancelToolCallId = toolCallIdForSource(
      fixture,
      foregroundCancel.runId,
      'subagent',
    );
    const foregroundCancelReceipt = await fixture.clients.runs.cancelRun({
      clientActionId: 'real-subagent-foreground-cancel-request',
      threadId: mainId,
      runId: foregroundCancel.runId,
      reason: 'REQ05 foreground cancellation acceptance',
    });
    expect(foregroundCancelReceipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, mainId, foregroundCancel.runId, RunStatus.CANCELLED);
    await waitRun(
      fixture,
      mainId,
      requiredString(foregroundCancelChild.run_id, 'Foreground child Run ID'),
      RunStatus.CANCELLED,
    );
    await waitInteraction(fixture, foregroundCancelToolCallId, 'cancelled');
    expect(interactionRow(fixture, foregroundCancelToolCallId).response_message_seq).toBeNull();
    await expect(readFile(foregroundFinished, 'utf8')).rejects.toThrow();

    const backgroundInternalCommand = `node -e "console.log('REQ05_BACKGROUND_INTERNAL_' + require('node:crypto').randomUUID())"`;
    const backgroundTask = `Call bash exactly once with cwd ${directory}, timeoutSeconds 30, and this exact command:\n${backgroundInternalCommand}\nAfter bash returns, reply exactly BACKGROUND_RESULT. Do not call any other tool.`;
    const background = await runForTool(
      fixture,
      mainId,
      'real-subagent-background',
      `Call subagent exactly once with mode background and this exact task:\n${backgroundTask}\nAfter the acceptance receipt, reply briefly. Do not call task_output or any other tool.`,
      'subagent',
    );
    const backgroundReceipt = parsedTool(background.result);
    const backgroundToolCallId = requiredString(
      backgroundReceipt.tool_call_id,
      'Background interaction ID',
    );
    expect(backgroundReceipt.status).toBe('accepted');
    expect(interactionRow(fixture, backgroundToolCallId)).toMatchObject({
      kind: 'subagent',
      execution_mode: 'background',
    });
    const backgroundChild = childRun(fixture, background.runId);
    expect(backgroundChild.execution_mode).toBe('background');
    await waitDelivered(fixture, mainId, backgroundToolCallId, 'subagent_response');
    await waitInteraction(fixture, backgroundToolCallId, 'completed');
    expect(responseText(fixture, backgroundToolCallId)).toContain('BACKGROUND_RESULT');
    const backgroundBash = toolResults(
      fixture,
      mainId,
      requiredString(backgroundChild.run_id, 'Background success child Run ID'),
      'bash',
    );
    expect(backgroundBash).toHaveLength(1);
    const backgroundInternalMarker = requiredString(
      backgroundBash[0]?.content.match(/REQ05_BACKGROUND_INTERNAL_[0-9a-f-]{36}/)?.[0],
      'Background internal tool marker',
    );

    const status = await runForTool(
      fixture,
      mainId,
      'real-subagent-background-status',
      `Call task_output exactly once with task_id ${backgroundToolCallId} and wait_ms 30000. Report its actual result. Do not call any other tool.`,
      'task_output',
    );
    expect(parsedTool(status.result)).toMatchObject({
      tool_call_id: backgroundToolCallId,
      status: 'completed',
      response: responseText(fixture, backgroundToolCallId),
      timed_out: false,
    });
    expect(
      toolResults(fixture, mainId, background.runId, 'subagent').filter(
        (row) => row.toolCallId === background.result.toolCallId,
      ),
    ).toHaveLength(1);

    const mainRequests = provider.requests.filter((request) =>
      request.tools.some((tool) => tool.name === 'thread_call'),
    );
    expect(mainRequests.length).toBeGreaterThan(0);
    const serializedMainRequests = JSON.stringify(mainRequests);
    const mainContext = await fixture.clients.context.readContext({
      threadId: mainId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 500,
    });
    const serializedMainContext = JSON.stringify(mainContext.messages, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const marker of [foregroundInternalMarker, backgroundInternalMarker]) {
      expect(serializedMainRequests).not.toContain(marker);
      expect(serializedMainContext).not.toContain(marker);
    }

    const backgroundStarted = join(directory, 'background-cancel-started.txt');
    const backgroundFinished = join(directory, 'background-cancel-finished.txt');
    const backgroundCancelTask = `Call bash exactly once with cwd ${directory}, timeoutSeconds 60, and this exact command:\nprintf started > ${backgroundStarted}; sleep 30; printf finished > ${backgroundFinished}\nDo not call any other tool.`;
    const backgroundCancel = await runForTool(
      fixture,
      mainId,
      'real-subagent-background-cancel',
      `Call subagent exactly once with mode background and this exact task:\n${backgroundCancelTask}\nAfter the acceptance receipt, reply briefly. Do not call task_stop or any other tool.`,
      'subagent',
    );
    const backgroundCancelReceipt = parsedTool(backgroundCancel.result);
    const backgroundCancelToolCallId = requiredString(
      backgroundCancelReceipt.tool_call_id,
      'Background cancellation interaction ID',
    );
    expect(backgroundCancelReceipt.status).toBe('accepted');
    await waitFile(backgroundStarted, 'started');
    const backgroundCancelChild = childRun(fixture, backgroundCancel.runId);
    expect(backgroundCancelChild.execution_mode).toBe('background');
    expect(['running', 'waiting']).toContain(
      interactionRow(fixture, backgroundCancelToolCallId).status,
    );

    const cancel = await runForTool(
      fixture,
      mainId,
      'real-subagent-background-cancel-request',
      `Call task_stop exactly once with task_id ${backgroundCancelToolCallId}. Report its actual receipt. Do not call any other tool.`,
      'task_stop',
    );
    expect(['cancel_requested', 'cancelled']).toContain(parsedTool(cancel.result).status);
    await waitInteraction(fixture, backgroundCancelToolCallId, 'cancelled');
    expect(interactionRow(fixture, backgroundCancelToolCallId).response_message_seq).toBeNull();
    await waitRun(
      fixture,
      mainId,
      requiredString(backgroundCancelChild.run_id, 'Background child Run ID'),
      RunStatus.CANCELLED,
    );
    await waitDelivered(fixture, mainId, backgroundCancelToolCallId, 'subagent_response');
    await expect(readFile(backgroundFinished, 'utf8')).rejects.toThrow();
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}

function deliveryRowOrUndefined(
  fixture: Fixture,
  toolCallId: string,
): Record<string, unknown> | undefined {
  const row: unknown = fixture.database
    .prepare(
      'SELECT source_tool_call_id, status FROM interaction_deliveries WHERE source_tool_call_id = ?',
    )
    .get(toolCallId);
  if (row === undefined) return undefined;
  if (!isRecord(row)) throw new Error('Invalid delivery record.');
  return row;
}
