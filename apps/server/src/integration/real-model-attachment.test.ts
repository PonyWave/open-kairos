import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type {
  DetailedModelUsage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from '@kairos/agent-core';
import {
  type Attachment,
  AttachmentService,
  InputMode,
  MessageRole,
  RunStatus,
} from '@kairos/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { accessToken, closeFixture, startFixture } from './delegation-fixture.js';
import { readRealModelConfig } from './real-model-config.js';
import { testSessionHeaders } from './test-authentication.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const expectedModelId = 'kimi-k2.8-highspeed';

interface UsageRecord {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
}

interface RealModelReport {
  status: 'passed' | 'failed';
  command: 'caffeinate -di env KAIROS_MODEL_ENV_FILE=<existing-model-env> bash scripts/real-model.sh attachment';
  commit: string;
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  temporary_data_directory: 'fresh_empty_mkdtemp';
  checks: Record<string, 'passed' | 'failed'>;
  requests: Array<{
    kind: 'text' | 'vision';
    provider_content_blocks: Array<Record<string, unknown>>;
    usage: UsageRecord | null;
  }>;
  answers: { text?: string; vision?: string };
  fixtures: Array<{
    file_name: string;
    media_type: string;
    byte_size: number;
    sha256: string;
    width: number | null;
    height: number | null;
  }>;
  evidence: {
    upload_download_sqlite_blob: boolean;
    input_context_associations: boolean;
    provider_actual_content_blocks: boolean;
    unique_text_marker: boolean;
    multiple_image_distinction: boolean;
  };
  usage: UsageRecord;
  failures: string[];
  unverified: string[];
}

const report: RealModelReport = {
  status: 'passed',
  command:
    'caffeinate -di env KAIROS_MODEL_ENV_FILE=<existing-model-env> bash scripts/real-model.sh attachment',
  commit: '',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  temporary_data_directory: 'fresh_empty_mkdtemp',
  checks: {},
  requests: [],
  answers: {},
  fixtures: [],
  evidence: {
    upload_download_sqlite_blob: false,
    input_context_associations: false,
    provider_actual_content_blocks: false,
    unique_text_marker: false,
    multiple_image_distinction: false,
  },
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: null },
  failures: [],
  unverified: ['real_text_attachment', 'real_png_jpeg_multimage_vision'],
};

const providerBodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
const imageBlockSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.literal('low') }),
});
const contentBlockSchema = z.discriminatedUnion('type', [textBlockSchema, imageBlockSchema]);
type ContentBlock = z.infer<typeof contentBlockSchema>;

class ObservedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly httpBodies: unknown[] = [];
  readonly requestUsages: DetailedModelUsage[] = [];
  readonly source: OpenAICompatibleProvider;

  constructor(config: ReturnType<typeof readRealModelConfig>) {
    const captureFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('The Provider request body is not captured JSON text.');
      }
      this.httpBodies.push(JSON.parse(init.body));
      return fetch(input, init);
    };
    this.source = new OpenAICompatibleProvider(
      {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.modelId,
        contextWindow: config.contextWindow,
        outputReserve: config.outputReserve,
        requestTimeoutMs: config.requestTimeoutMs,
      },
      captureFetch,
    );
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const requestIndex = this.requests.push(structuredClone(request)) - 1;
    for await (const event of this.source.stream(request, signal)) {
      if ((event.type === 'response' || event.type === 'stream_interrupted') && event.usage) {
        this.requestUsages[requestIndex] = event.usage;
        addUsage(event.usage);
      }
      yield event;
    }
  }
}

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

function attachmentsClient(baseUrl: string) {
  const authentication: Interceptor = (next) => async (request) => {
    for (const [name, value] of Object.entries(testSessionHeaders(accessToken)))
      request.header.set(name, value);
    return next(request);
  };
  const transport = connectNode.createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [authentication],
  });
  return createClient(AttachmentService, transport);
}

async function startRealFixture(directory: string, config: ReturnType<typeof readRealModelConfig>) {
  const provider = new ObservedProvider(config);
  const fixture = await startFixture(directory, {
    provider,
    contextWindowTokens: config.contextWindow,
    outputReserveTokens: config.outputReserve,
    countTokens: (request) => provider.source.estimateRequestTokens(request),
  });
  return { ...fixture, provider, attachments: attachmentsClient(fixture.baseUrl) };
}

type RealFixture = Awaited<ReturnType<typeof startRealFixture>>;

function addUsage(usage: DetailedModelUsage): void {
  report.usage.input_tokens += usage.input_tokens;
  report.usage.output_tokens += usage.output_tokens;
  report.usage.total_tokens += usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) {
    report.usage.cached_tokens = (report.usage.cached_tokens ?? 0) + cached;
  }
}

function usageRecord(usage: DetailedModelUsage): UsageRecord {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
  };
}

function safeError(error: unknown): string {
  const secret = process.env.KAIROS_MODEL_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return (secret ? message.replaceAll(secret, '[redacted]') : message)
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function recordFailure(stage: string, error: unknown): void {
  report.status = 'failed';
  report.failures.push(`${stage}: ${safeError(error)}`);
}

async function recordCheck(name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.checks[name] = 'passed';
    report.unverified = report.unverified.filter((candidate) => candidate !== name);
  } catch (error) {
    report.checks[name] = 'failed';
    recordFailure(name, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitRealRun(fixture: RealFixture, threadId: string, runId: string): Promise<void> {
  const terminal = [
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
  ];
  await vi.waitFor(
    async () => {
      const snapshot = await fixture.clients.thread.getThread({ threadId });
      const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
      expect(run && terminal.includes(run.status)).toBe(true);
    },
    { timeout: 180_000 },
  );
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
  expect(run?.status).toBe(RunStatus.COMPLETED);
  expect(run?.usage?.inputTokens ?? 0n).toBeGreaterThan(0n);
  expect(run?.usage?.outputTokens ?? 0n).toBeGreaterThan(0n);
}

async function uploadAndVerify(
  fixture: RealFixture,
  clientActionId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<Attachment> {
  const uploaded = await fixture.attachments.uploadAttachment({
    clientActionId,
    fileName,
    data: bytes,
  });
  if (!uploaded.attachment) throw new Error('Upload returned no attachment.');
  const attachment = uploaded.attachment;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(attachment.sizeBytes).toBe(BigInt(bytes.length));
  expect(attachment.sha256).toBe(sha256);
  const stored = z
    .object({
      media_type: z.string(),
      byte_size: z.number().int().positive(),
      sha256: z.string(),
      content: z.instanceof(Uint8Array),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
    })
    .parse(
      fixture.database
        .prepare(
          `SELECT media_type, byte_size, sha256, content, width, height
           FROM attachments WHERE attachment_id = ?`,
        )
        .get(attachment.attachmentId),
    );
  expect(stored.media_type).toBe(attachment.mediaType);
  expect(stored.byte_size).toBe(bytes.length);
  expect(stored.sha256).toBe(sha256);
  expect(Buffer.from(stored.content).equals(bytes)).toBe(true);
  const downloaded = await fixture.attachments.downloadAttachment({
    attachmentId: attachment.attachmentId,
    limitBytes: 262_144,
  });
  expect(Buffer.from(downloaded.data).equals(bytes)).toBe(true);
  expect(downloaded.nextOffset).toBeUndefined();
  report.fixtures.push({
    file_name: attachment.fileName,
    media_type: attachment.mediaType,
    byte_size: bytes.length,
    sha256,
    width: stored.width,
    height: stored.height,
  });
  report.evidence.upload_download_sqlite_blob = true;
  return attachment;
}

async function createAttachmentThread(
  fixture: RealFixture,
  clientActionId: string,
  title: string,
  prompt: string,
  attachments: readonly Attachment[],
): Promise<{ threadId: string; runId: string }> {
  const created = await fixture.clients.thread.createThread({
    clientActionId,
    title,
    initialText: prompt,
    initialMode: InputMode.FOLLOW_UP,
    initialAttachmentIds: attachments.map((attachment) => attachment.attachmentId),
  });
  if (!created.thread || !created.runId) throw new Error('The attachment Run was not created.');
  const threadId = created.thread.threadId;
  await waitRealRun(fixture, threadId, created.runId);
  return { threadId, runId: created.runId };
}

async function verifyCommittedAttachments(
  fixture: RealFixture,
  threadId: string,
  runId: string,
  attachments: readonly Attachment[],
): Promise<string> {
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const input = snapshot.snapshot?.inputs[0];
  const user = snapshot.snapshot?.messages.find((message) => message.role === MessageRole.USER);
  if (!input || !user) throw new Error('The committed attachment Input or message is missing.');
  const expectedIds = attachments.map((attachment) => attachment.attachmentId);
  expect(input.attachments.map((attachment) => attachment.attachmentId)).toEqual(expectedIds);
  expect(user.attachments.map((attachment) => attachment.attachmentId)).toEqual(expectedIds);
  const inputLinks = z
    .array(z.object({ attachment_id: z.string() }))
    .parse(
      fixture.database
        .prepare('SELECT attachment_id FROM input_attachments WHERE input_id = ? ORDER BY position')
        .all(input.inputId),
    );
  expect(inputLinks.map((link) => link.attachment_id)).toEqual(expectedIds);
  const contextLinks = z.array(z.object({ attachment_id: z.string() })).parse(
    fixture.database
      .prepare(
        `SELECT attachment_id FROM context_message_attachments
           WHERE message_seq = ? ORDER BY position`,
      )
      .all(Number(user.seq)),
  );
  expect(contextLinks.map((link) => link.attachment_id)).toEqual(expectedIds);
  const audit = await fixture.clients.context.readContext({
    threadId,
    agentId: 'thread',
    afterSeq: 0n,
    limit: 100,
  });
  expect(
    audit.messages
      .find((message) => message.messageId === user.messageId)
      ?.attachments.map((attachment) => attachment.attachmentId),
  ).toEqual(expectedIds);
  const storedRequest = z.object({ request_json: z.string() }).parse(
    fixture.database
      .prepare(
        `SELECT request_json FROM model_request_records
           WHERE thread_id = ? AND status = 'completed'`,
      )
      .get(threadId),
  );
  for (const attachmentId of expectedIds) {
    expect(storedRequest.request_json).toContain(attachmentId);
  }
  expect(storedRequest.request_json).not.toContain('base64,');
  report.evidence.input_context_associations = true;
  const answer = snapshot.snapshot?.messages
    .filter((message) => message.role === MessageRole.ASSISTANT && message.runId === runId)
    .at(-1)?.content;
  if (answer === undefined) throw new Error('The real assistant response is missing.');
  return answer;
}

function providerContentBlocks(body: unknown): ContentBlock[] {
  const parsed = providerBodySchema.parse(body);
  expect(parsed.model).toBe(expectedModelId);
  const last = parsed.messages.at(-1);
  expect(last?.role).toBe('user');
  return z.array(contentBlockSchema).parse(last?.content);
}

function decodedImage(block: ContentBlock): { mediaType: string; bytes: Buffer } {
  const image = imageBlockSchema.parse(block);
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    image.image_url.url,
  );
  if (!match || typeof match[1] !== 'string' || typeof match[2] !== 'string') {
    throw new Error('The Provider image_url is not an accepted PNG or JPEG data URL.');
  }
  return { mediaType: match[1], bytes: Buffer.from(match[2], 'base64') };
}

function expectImage(block: ContentBlock | undefined, mediaType: string, bytes: Uint8Array): void {
  if (!block) throw new Error('The Provider image block is missing.');
  const decoded = decodedImage(block);
  expect(decoded.mediaType).toBe(mediaType);
  expect(decoded.bytes.equals(bytes)).toBe(true);
}

function summarizeBlocks(blocks: readonly ContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    const decoded = decodedImage(block);
    return {
      type: 'image_url',
      media_type: decoded.mediaType,
      detail: 'low',
      byte_size: decoded.bytes.length,
      sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
    };
  });
}

async function createVisualFixtures(directory: string) {
  const fixtureDirectory = join(directory, 'fixtures');
  await mkdir(fixtureDirectory);
  const fontCandidates = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  let font = '';
  for (const candidate of fontCandidates) {
    try {
      await access(candidate);
      font = candidate;
      break;
    } catch {
      // Try the next known safe font location.
    }
  }
  if (!font) throw new Error('No known local font is available for synthetic image generation.');
  const pngPath = join(fixtureDirectory, 'vision-a.png');
  const jpegPath = join(fixtureDirectory, 'vision-b.jpg');
  const shared = [
    '-fill',
    '#111827',
    '-stroke',
    'none',
    '-font',
    font,
    '-pointsize',
    '64',
    '-gravity',
    'south',
  ];
  await execFileAsync(
    'magick',
    [
      '-size',
      '640x400',
      'xc:#f8fafc',
      '-fill',
      '#dc2626',
      '-stroke',
      '#7f1d1d',
      '-strokewidth',
      '8',
      '-draw',
      'circle 320,170 320,45',
      ...shared,
      '-annotate',
      '+0+28',
      'RED-731',
      '-depth',
      '8',
      `PNG24:${pngPath}`,
    ],
    { timeout: 10_000 },
  );
  await execFileAsync(
    'magick',
    [
      '-size',
      '640x400',
      'xc:#f8fafc',
      '-fill',
      '#2563eb',
      '-stroke',
      '#172554',
      '-strokewidth',
      '8',
      '-draw',
      'rectangle 180,45 460,285',
      ...shared,
      '-annotate',
      '+0+28',
      'BLUE-942',
      '-depth',
      '8',
      jpegPath,
    ],
    { timeout: 10_000 },
  );
  return {
    png: await readFile(pngPath),
    jpeg: await readFile(jpegPath),
  };
}

async function runTextAcceptance(fixture: RealFixture): Promise<void> {
  const marker = `KAIROS-TEXT-${randomUUID().toUpperCase()}`;
  const prompt =
    'Read the attached UTF-8 text file. Reply with only the exact unique marker it contains, without punctuation or explanation. Do not call tools.';
  const attachment = await uploadAndVerify(
    fixture,
    'real-upload-text',
    'acceptance-marker.txt',
    new TextEncoder().encode(`${marker}\n`),
  );
  const before = fixture.provider.httpBodies.length;
  const { threadId, runId } = await createAttachmentThread(
    fixture,
    'real-create-text-attachment',
    'Real text attachment acceptance',
    prompt,
    [attachment],
  );
  const answer = await verifyCommittedAttachments(fixture, threadId, runId, [attachment]);
  report.answers.text = answer;
  expect(answer.trim()).toBe(marker);
  expect(fixture.provider.httpBodies.length).toBe(before + 1);
  const blocks = providerContentBlocks(fixture.provider.httpBodies[before]);
  expect(blocks).toEqual([
    { type: 'text', text: prompt },
    { type: 'text', text: 'Attachment: acceptance-marker.txt' },
    { type: 'text', text: `${marker}\n` },
  ]);
  report.evidence.provider_actual_content_blocks = true;
  report.evidence.unique_text_marker = true;
}

async function runVisionAcceptance(fixture: RealFixture, directory: string): Promise<void> {
  const images = await createVisualFixtures(directory);
  const png = await uploadAndVerify(fixture, 'real-upload-png', 'vision-a.png', images.png);
  const jpeg = await uploadAndVerify(fixture, 'real-upload-jpeg', 'vision-b.jpg', images.jpeg);
  expect(png.mediaType).toBe('image/png');
  expect(jpeg.mediaType).toBe('image/jpeg');
  expect(png.width).toBe(640);
  expect(png.height).toBe(400);
  expect(jpeg.width).toBe(640);
  expect(jpeg.height).toBe(400);
  const prompt = `Inspect both attached images and distinguish them by file name. Reply with exactly two lines in this format, substituting the observed values:
vision-a.png: <uppercase color> <lowercase shape> <large text>
vision-b.jpg: <uppercase color> <lowercase shape> <large text>
Do not call tools.`;
  const before = fixture.provider.httpBodies.length;
  const { threadId, runId } = await createAttachmentThread(
    fixture,
    'real-create-vision-attachments',
    'Real PNG and JPEG attachment acceptance',
    prompt,
    [png, jpeg],
  );
  const answer = await verifyCommittedAttachments(fixture, threadId, runId, [png, jpeg]);
  report.answers.vision = answer;
  const lines = answer.trim().split(/\r?\n/);
  expect(lines).toHaveLength(2);
  const first = lines[0] ?? '';
  const second = lines[1] ?? '';
  expect(first).toMatch(/^vision-a\.png:/i);
  expect(first).toMatch(/\bRED\b/i);
  expect(first).toMatch(/\bcircle\b/i);
  expect(first).toContain('RED-731');
  expect(first).not.toMatch(/\bBLUE\b/i);
  expect(first).not.toContain('BLUE-942');
  expect(second).toMatch(/^vision-b\.jpg:/i);
  expect(second).toMatch(/\bBLUE\b/i);
  expect(second).toMatch(/\b(square|rectangle)\b/i);
  expect(second).toContain('BLUE-942');
  expect(second).not.toContain('RED-731');
  expect(second.replace('BLUE', '')).not.toMatch(/\bRED\b/i);
  expect(fixture.provider.httpBodies.length).toBe(before + 1);
  const blocks = providerContentBlocks(fixture.provider.httpBodies[before]);
  expect(blocks).toHaveLength(5);
  expect(blocks[0]).toEqual({ type: 'text', text: prompt });
  expect(blocks[1]).toEqual({ type: 'text', text: 'Attachment: vision-a.png' });
  expect(blocks[3]).toEqual({ type: 'text', text: 'Attachment: vision-b.jpg' });
  expectImage(blocks[2], 'image/png', images.png);
  expectImage(blocks[4], 'image/jpeg', images.jpeg);
  report.evidence.provider_actual_content_blocks = true;
  report.evidence.multiple_image_distinction = true;
}

async function writeAcceptanceReport(): Promise<void> {
  const reportPath =
    process.env.KAIROS_REAL_MODEL_REPORT ??
    join(repositoryRoot, 'work/attachment-workbench-acceptance.json');
  let previous: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
    if (isRecord(value)) previous = value;
  } catch {
    previous = {};
  }
  const output = acceptanceReportOutput(previous);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function acceptanceReportOutput(previous: Record<string, unknown>) {
  const browserStatus = isRecord(previous.browser) ? previous.browser.status : undefined;
  const finalStatus = isRecord(previous.final_checks) ? previous.final_checks.status : undefined;
  const delegationStatus = isRecord(previous.real_thread_delegation)
    ? previous.real_thread_delegation.status
    : undefined;
  const unverified = new Set(
    Array.isArray(previous.unverified)
      ? previous.unverified.filter((item): item is string => typeof item === 'string')
      : [],
  );
  if (browserStatus === 'passed') unverified.delete('browser_desktop_and_narrow_workbench');
  else unverified.add('browser_desktop_and_narrow_workbench');
  if (finalStatus === 'passed') unverified.delete('final_pnpm_check_and_acceptance');
  else unverified.add('final_pnpm_check_and_acceptance');
  if (delegationStatus === 'passed') unverified.delete('real_thread_delegation');
  else unverified.add('real_thread_delegation');
  const failed =
    report.status === 'failed' ||
    browserStatus === 'failed' ||
    finalStatus === 'failed' ||
    delegationStatus === 'failed';
  return {
    ...previous,
    version: 1,
    status: failed ? 'failed' : unverified.size === 0 ? 'passed' : 'incomplete',
    commit: report.commit,
    real_model: report,
    unverified: [...unverified],
  };
}

describe('acceptance report merging', () => {
  it('preserves unrelated unverified items while clearing completed sections', () => {
    report.status = 'passed';
    const output = acceptanceReportOutput({
      browser: { status: 'passed' },
      final_checks: { status: 'passed' },
      real_thread_delegation: { status: 'passed', evidence: 'retained' },
      unverified: ['real_thread_delegation', 'future_pending_check'],
    });
    expect(output.status).toBe('incomplete');
    expect(output.unverified).toEqual(['future_pending_check']);
    expect(output).toMatchObject({
      real_thread_delegation: { status: 'passed', evidence: 'retained' },
    });
  });

  it('passes only when browser, final checks and real delegation all pass', () => {
    report.status = 'passed';
    const output = acceptanceReportOutput({
      browser: { status: 'passed' },
      final_checks: { status: 'passed' },
      real_thread_delegation: { status: 'passed' },
      unverified: [],
    });
    expect(output.status).toBe('passed');
    expect(output.unverified).toEqual([]);
  });

  it('keeps a failed delegation visible instead of clearing it', () => {
    report.status = 'passed';
    const output = acceptanceReportOutput({
      browser: { status: 'passed' },
      final_checks: { status: 'passed' },
      real_thread_delegation: { status: 'failed' },
      unverified: ['real_thread_delegation', 'future_pending_check'],
    });
    expect(output.status).toBe('failed');
    expect(output.unverified).toEqual(['real_thread_delegation', 'future_pending_check']);
  });
});

describe.skipIf(!enabled)('real attachment acceptance', () => {
  afterAll(writeAcceptanceReport);

  it('sends one unique text marker and distinguishes synthetic PNG and JPEG images', async () => {
    report.commit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
    ).stdout.trim();
    let config: ReturnType<typeof readRealModelConfig>;
    try {
      config = readRealModelConfig();
      expect(config.modelId).toBe(expectedModelId);
    } catch (error) {
      recordFailure('configuration', error);
      throw error;
    }
    report.model.modelId = config.modelId;
    const directory = await mkdtemp(join(tmpdir(), 'kairos-real-attachment-'));
    let fixture: RealFixture | undefined;
    try {
      fixture = await startRealFixture(directory, config);
    } catch (error) {
      recordFailure('startup', error);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    try {
      await recordCheck('real_text_attachment', () => runTextAcceptance(fixture));
      await recordCheck('real_png_jpeg_multimage_vision', () =>
        runVisionAcceptance(fixture, directory),
      );
      report.requests = fixture.provider.httpBodies.map((body, index) => {
        const blocks = providerContentBlocks(body);
        const firstText = blocks[0]?.type === 'text' ? blocks[0].text : '';
        return {
          kind: firstText.includes('UTF-8 text file') ? 'text' : 'vision',
          provider_content_blocks: summarizeBlocks(blocks),
          usage: fixture.provider.requestUsages[index]
            ? usageRecord(fixture.provider.requestUsages[index])
            : null,
        };
      });
      expect(fixture.provider.httpBodies).toHaveLength(2);
      expect(report.failures).toEqual([]);
    } finally {
      await closeFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  }, 600_000);
});
