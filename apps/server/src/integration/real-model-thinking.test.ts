import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelProvider } from '@kairos/agent-core';
import {
  ContentBlockType,
  type Message,
  MessageRole,
  RunStatus,
  type WatchThreadResponse,
} from '@kairos/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { readRealModelConfig } from './real-model-config.js';
import {
  closeThinkingFixture,
  createThinkingThread,
  sendThinkingMessage,
  startThinkingFixture,
} from './thinking-fixture.js';

const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const reasoningAliases = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;
const terminalStatuses = [
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
];

interface ReasoningFieldObservation {
  field: string;
  valueType: string;
  classification: 'plain' | 'summary' | 'encrypted' | 'other';
}

interface ProviderObservation {
  responseIndex: number;
  deltaFields: string[];
  reasoningFields: ReasoningFieldObservation[];
  plainReasoning?: { field: string; text: string };
}

interface ThinkingRealModelReport {
  version: 1;
  status: 'passed' | 'unverified' | 'failed';
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  command: string;
  runStatus?: string;
  usage?: { inputTokens: string; outputTokens: string };
  checks: Record<string, 'passed' | 'failed' | 'unverified'>;
  providerResponses: ProviderObservation[];
  result?: {
    messageId: string;
    plainReasoningField: string;
    providerOriginal: string;
    streamedThinking: string;
    persistedThinking: string;
    ordinaryContent: string;
  };
  failures: string[];
  unverified: string[];
}

const report: ThinkingRealModelReport = {
  version: 1,
  status: 'passed',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  command: 'bash scripts/real-model.sh thinking',
  checks: {},
  providerResponses: [],
  failures: [],
  unverified: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function reasoningClassification(field: string, value: unknown) {
  if (/summary/i.test(field)) return 'summary' as const;
  if (/encrypt/i.test(field)) return 'encrypted' as const;
  if (reasoningAliases.includes(field as (typeof reasoningAliases)[number])) {
    return typeof value === 'string' ? ('plain' as const) : ('other' as const);
  }
  return 'other' as const;
}

async function observeProviderResponse(
  response: Response,
  responseIndex: number,
): Promise<ProviderObservation> {
  const observation: ProviderObservation = {
    responseIndex,
    deltaFields: [],
    reasoningFields: [],
  };
  const deltaFields = new Set<string>();
  const reasoningFields = new Map<string, ReasoningFieldObservation>();
  let plainField: (typeof reasoningAliases)[number] | undefined;
  let plainText = '';
  const body = await response.text();
  for (const part of body.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(value) || !Array.isArray(value.choices)) continue;
    for (const choice of value.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue;
      const delta = choice.delta;
      for (const field of Object.keys(delta)) deltaFields.add(field);
      for (const [field, fieldValue] of Object.entries(delta)) {
        if (!/reason|thought|summary|encrypt/i.test(field)) continue;
        const key = `${field}:${valueType(fieldValue)}`;
        reasoningFields.set(key, {
          field,
          valueType: valueType(fieldValue),
          classification: reasoningClassification(field, fieldValue),
        });
      }
      if (plainField === undefined) {
        plainField = reasoningAliases.find((alias) => {
          const candidate = delta[alias];
          return typeof candidate === 'string' && candidate.length > 0;
        });
      }
      if (plainField !== undefined) {
        const candidate = delta[plainField];
        if (typeof candidate === 'string' && candidate.length > 0) plainText += candidate;
      }
    }
  }
  observation.deltaFields = [...deltaFields].sort();
  observation.reasoningFields = [...reasoningFields.values()];
  if (plainField !== undefined && plainText.length > 0) {
    observation.plainReasoning = { field: plainField, text: plainText };
  }
  return observation;
}

function deltaDetails(response: WatchThreadResponse) {
  if (response.payload.case !== 'textDelta' && response.payload.case !== 'thinkingDelta') {
    return undefined;
  }
  return {
    type: response.payload.case,
    messageId: response.payload.value.messageId,
    deltaSeq: response.payload.value.deltaSeq,
    blockIndex: response.payload.value.blockIndex,
    text: response.payload.value.text,
  };
}

function protocolBlocks(message: Message) {
  return message.contentBlocks.map((block) => ({
    type: block.type === ContentBlockType.THINKING ? ('thinking' as const) : ('text' as const),
    block_index: block.blockIndex,
    text: block.text,
  }));
}

function markUnverified(name: string, detail: string): void {
  report.checks[name] = 'unverified';
  report.unverified.push(`${name}: ${detail}`);
  if (report.status !== 'failed') report.status = 'unverified';
}

function markFailed(name: string, error: unknown): void {
  report.checks[name] = 'failed';
  report.status = 'failed';
  report.failures.push(`${name}: ${safeError(error)}`);
}

function safeError(error: unknown): string {
  const secret = process.env.KAIROS_MODEL_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return (secret ? message.replaceAll(secret, '[redacted]') : message)
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

const storedAssistantSchema = z.object({
  message_id: z.string(),
  content: z.string(),
  content_blocks_json: z.string().nullable(),
});
const storedBlocksSchema = z.array(
  z.object({
    type: z.enum(['text', 'thinking']),
    block_index: z.number().int().nonnegative(),
    text: z.string(),
  }),
);

describe.skipIf(!enabled)('real model Thinking acceptance', () => {
  afterAll(async () => {
    const reportPath =
      process.env.KAIROS_REAL_MODEL_REPORT ??
      join(repositoryRoot, 'work/thinking-real-model-acceptance.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('records actual reasoning fields and verifies plain Thinking through real Connect and SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kairos-real-thinking-'));
    let fixture: Awaited<ReturnType<typeof startThinkingFixture>> | undefined;
    try {
      const config = readRealModelConfig();
      report.model.modelId = config.modelId;
      const observations: ProviderObservation[] = [];
      const pendingObservations: Promise<void>[] = [];
      const observingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (response.ok) {
          const pending = observeProviderResponse(response.clone(), observations.length)
            .then((observation) => {
              observations.push(observation);
            })
            .catch((error: unknown) => {
              markFailed('provider_response_observation', error);
            });
          pendingObservations.push(pending);
        }
        return response;
      };
      const source = new OpenAICompatibleProvider(
        {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.modelId,
          contextWindow: config.contextWindow,
          outputReserve: config.outputReserve,
          requestTimeoutMs: config.requestTimeoutMs,
        },
        observingFetch,
      );
      const provider: ModelProvider = source;
      fixture = await startThinkingFixture(directory, {
        provider,
        contextWindowTokens: config.contextWindow,
        outputReserveTokens: config.outputReserve,
        countTokens: (request) => source.estimateRequestTokens(request),
      });
      const threadId = await createThinkingThread(fixture, 'real-thinking-thread');
      const initialCursor = (await fixture.clients.thread.getThread({ threadId })).throughSeq;
      const controller = new AbortController();
      const watch = fixture.clients.events
        .watchThread({ threadId, afterSeq: initialCursor }, { signal: controller.signal })
        [Symbol.asyncIterator]();
      const runId = await sendThinkingMessage(
        fixture,
        threadId,
        'real-thinking-input',
        'Calculate 347 times 26. Use the reasoning capability of this endpoint, then give the numeric answer and one short verification sentence. Do not call tools.',
      );
      const deltas: NonNullable<ReturnType<typeof deltaDetails>>[] = [];
      const committed: Message[] = [];
      let terminal = false;
      while (!terminal) {
        const item = await watch.next();
        if (item.done) throw new Error('Real WatchThread ended before a terminal Run event.');
        const delta = deltaDetails(item.value);
        if (delta) deltas.push(delta);
        if (
          item.value.payload.case === 'event' &&
          item.value.payload.value.payload.case === 'messageCommitted'
        ) {
          const message = item.value.payload.value.payload.value.message;
          if (message?.role === MessageRole.ASSISTANT) committed.push(message);
        }
        if (
          item.value.payload.case === 'event' &&
          item.value.payload.value.payload.case === 'runChanged' &&
          item.value.payload.value.payload.value.run?.runId === runId &&
          terminalStatuses.includes(item.value.payload.value.payload.value.run.status)
        ) {
          terminal = true;
        }
      }
      await watch.return?.();
      controller.abort();
      await Promise.all(pendingObservations);
      report.providerResponses = observations;
      const finalSnapshot = await fixture.clients.thread.getThread({ threadId });
      const run = finalSnapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
      report.runStatus = run ? RunStatus[run.status].toLowerCase() : 'missing';
      if (run?.usage) {
        report.usage = {
          inputTokens: run.usage.inputTokens.toString(),
          outputTokens: run.usage.outputTokens.toString(),
        };
      }
      const observation = observations.find((candidate) => candidate.plainReasoning);
      const plainReasoning = observation?.plainReasoning;
      const nonPlainFields = observations.flatMap((candidate) =>
        candidate.reasoningFields.filter((field) => field.classification !== 'plain'),
      );
      if (run?.status !== RunStatus.COMPLETED) {
        if (!plainReasoning && nonPlainFields.length > 0) {
          markUnverified(
            'real_provider_response',
            'The endpoint returned only summary, encrypted, or non-string reasoning fields.',
          );
        } else {
          throw new Error(`Real reasoning Run ended with status ${report.runStatus}.`);
        }
      } else {
        report.checks.real_provider_response = 'passed';
      }

      const streamedThinking = deltas
        .filter((delta) => delta.type === 'thinkingDelta')
        .map((delta) => delta.text)
        .join('');
      const assistant =
        committed.at(-1) ??
        finalSnapshot.snapshot?.messages.findLast(
          (message) => message.role === MessageRole.ASSISTANT,
        );
      if (!plainReasoning) {
        expect(streamedThinking).toBe('');
        const noReplacement =
          !assistant ||
          assistant.contentBlocks.every((block) => block.type !== ContentBlockType.THINKING);
        expect(noReplacement).toBe(true);
        report.checks.real_no_substitute_thinking = 'passed';
        markUnverified(
          'real_plain_reasoning',
          nonPlainFields.length > 0
            ? 'The endpoint returned summary, encrypted, or non-string reasoning fields without plain reasoning.'
            : 'The endpoint returned no reasoning field with plain text.',
        );
        markUnverified(
          'real_thinking_connect_sqlite_and_gui_protocol',
          'Plain reasoning was unavailable, so real Thinking persistence and GUI protocol projection were not verified.',
        );
        return;
      }
      if (run?.status !== RunStatus.COMPLETED) {
        throw new Error('Plain reasoning was returned but the Run did not complete.');
      }
      if (!assistant) throw new Error('The real reasoning response has no assistant message.');
      report.checks.real_plain_reasoning = 'passed';

      const reasoningText = assistant.contentBlocks
        .filter((block) => block.type === ContentBlockType.THINKING)
        .map((block) => block.text)
        .join('');
      const ordinaryText = assistant.contentBlocks
        .filter((block) => block.type === ContentBlockType.TEXT)
        .map((block) => block.text)
        .join('');
      expect(streamedThinking).toBe(plainReasoning.text);
      expect(reasoningText).toBe(plainReasoning.text);
      expect(ordinaryText).toBe(assistant.content);
      expect(deltas.filter((delta) => delta.type === 'thinkingDelta')).not.toEqual([]);
      expect(
        deltas
          .filter((delta) => delta.type === 'thinkingDelta')
          .every((delta) => delta.messageId === assistant.messageId),
      ).toBe(true);
      expect(deltas.map((delta) => delta.deltaSeq)).toEqual(
        deltas.map((_, index) => BigInt(index + 1)),
      );

      const stored = storedAssistantSchema.parse(
        fixture.database
          .prepare(
            "SELECT message_id, content, content_blocks_json FROM context_messages WHERE thread_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
          )
          .get(threadId),
      );
      const storedBlocks = storedBlocksSchema.parse(
        JSON.parse(stored.content_blocks_json ?? 'null'),
      );
      expect(stored.message_id).toBe(assistant.messageId);
      expect(stored.content).toBe(assistant.content);
      expect(storedBlocks).toEqual(protocolBlocks(assistant));
      const context = await fixture.clients.context.readContext({
        threadId,
        agentId: 'thread',
        afterSeq: 0n,
        limit: 100,
      });
      const projected = context.messages.find(
        (message) => message.messageId === assistant.messageId,
      );
      expect(projected?.contentBlocks).toEqual(assistant.contentBlocks);
      expect(projected?.content).toBe(assistant.content);
      const snapshotAssistant = finalSnapshot.snapshot?.messages.find(
        (message) => message.messageId === assistant.messageId,
      );
      expect(snapshotAssistant?.contentBlocks).toEqual(assistant.contentBlocks);
      report.result = {
        messageId: assistant.messageId,
        plainReasoningField: plainReasoning.field,
        providerOriginal: plainReasoning.text,
        streamedThinking,
        persistedThinking: reasoningText,
        ordinaryContent: assistant.content,
      };
      report.checks.real_thinking_connect_sqlite_and_gui_protocol = 'passed';
      report.checks.real_reasoning_matches_provider_original = 'passed';
      report.checks.real_ordinary_content_contains_only_text_blocks = 'passed';
    } catch (error) {
      markFailed('real_thinking_acceptance', error);
      throw error;
    } finally {
      if (fixture) await closeThinkingFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  }, 300_000);
});
