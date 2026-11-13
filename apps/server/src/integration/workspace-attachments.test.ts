import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@kairos/agent-core';
import { AttachmentSource, InputMode } from '@kairos/contracts';
import { OperationStatus } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pngBytes } from '../attachments/fixtures.js';
import { stripMessageMeta } from '../context/model-input.js';
import {
  type EnvironmentOperationAction,
  type EnvironmentOperationOutcome,
  EnvironmentOperationStore,
  emptyEnvironmentOutcome,
} from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { SqlRecallEngine } from '../recall/index.js';
import type {
  EnvironmentOperationGateway,
  EnvironmentOperationRecord,
} from '../sessions/environment-runtime.js';
import {
  ControlledEnvironmentOperations,
  seedReadyMainEnvironment,
  startRealEnvironmentServer,
} from './environment-fixture.js';

const ownerId = 'workspace-attachment-owner';
const accessToken = 'workspace-attachment-secret';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
type StartInput = Parameters<EnvironmentOperationGateway['startEnvironmentOperation']>[0];

class LocalSandboxOperations extends ControlledEnvironmentOperations {
  readonly #local = new Map<string, EnvironmentOperationRecord>();
  readonly #operationStore: EnvironmentOperationStore;

  constructor(
    environments: EnvironmentStore,
    private readonly root: string,
    private readonly workspacePrefix: string,
  ) {
    super(environments);
    this.#operationStore = new EnvironmentOperationStore(environments.database);
  }

  override async startEnvironmentOperation(input: StartInput): Promise<EnvironmentOperationRecord> {
    if (!['write', 'read', 'readImage'].includes(input.action.case)) {
      return super.startEnvironmentOperation(input);
    }
    const environment = this.environments.get(input.tenantId, input.envId);
    const action = structuredClone(input.action);
    const target = {
      operationId: input.operationId,
      envId: input.envId,
      deviceBindingId: environment.deviceBindingId ?? '',
      targetInstanceId: environment.instanceId ?? '',
      ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
    };
    this.#operationStore.createIntent({
      ...target,
      tenantId: input.tenantId,
      deviceId: environment.deviceId ?? '',
      ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
      action,
      expiresAt: input.expiresAt,
    });
    this.#operationStore.markSent(
      input.operationId,
      target.deviceBindingId,
      target.targetInstanceId,
    );
    this.#operationStore.recordAccepted({
      ...target,
      status: OperationStatus.RUNNING,
      acceptedAt: new Date(),
    });
    let operation: EnvironmentOperationRecord;
    let resultStatus: OperationStatus;
    let resultOutcome: EnvironmentOperationOutcome;
    try {
      resultOutcome = await this.#execute(action);
      resultStatus = OperationStatus.COMPLETED;
      operation = {
        operationId: input.operationId,
        tenantId: input.tenantId,
        envId: input.envId,
        deviceBindingId: environment.deviceBindingId ?? '',
        targetInstanceId: environment.instanceId ?? '',
        action,
        status: resultStatus,
        resultStatus,
        outcome: resultOutcome,
        outputComplete: true,
        postProcessedAt: new Date().toISOString(),
        resultSource: 'device',
        expiresAt: input.expiresAt.toISOString(),
      };
    } catch {
      resultOutcome = emptyEnvironmentOutcome(action);
      resultStatus = OperationStatus.FAILED;
      operation = {
        operationId: input.operationId,
        tenantId: input.tenantId,
        envId: input.envId,
        deviceBindingId: environment.deviceBindingId ?? '',
        targetInstanceId: environment.instanceId ?? '',
        action,
        status: resultStatus,
        resultStatus,
        outcome: resultOutcome,
        outputComplete: true,
        postProcessedAt: new Date().toISOString(),
        resultSource: 'device',
        expiresAt: input.expiresAt.toISOString(),
      };
    }
    this.#operationStore.recordResult({
      ...target,
      status: resultStatus,
      outcome: resultOutcome,
      observedAt: new Date(),
      source: 'device',
    });
    this.#operationStore.markPostProcessed(input.operationId);
    this.#local.set(input.operationId, operation);
    return operation;
  }

  override getEnvironmentOperation(
    tenantId: string,
    operationId: string,
  ): EnvironmentOperationRecord {
    return this.#local.get(operationId) ?? super.getEnvironmentOperation(tenantId, operationId);
  }

  override async cancelEnvironmentOperation(input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }): Promise<EnvironmentOperationRecord> {
    const operation = this.#local.get(input.operationId);
    if (!operation) return super.cancelEnvironmentOperation(input);
    operation.status = OperationStatus.CANCELLED;
    operation.resultStatus = OperationStatus.CANCELLED;
    operation.outcome = emptyEnvironmentOutcome(operation.action);
    return operation;
  }

  async #execute(action: EnvironmentOperationAction) {
    if (action.case !== 'write' && action.case !== 'read' && action.case !== 'readImage') {
      throw new Error('The local sandbox fixture only handles file operations.');
    }
    const logicalPath = action.value.path;
    if (!logicalPath.startsWith(`${this.workspacePrefix}/`))
      throw new Error('Invalid sandbox path.');
    const path = join(this.root, logicalPath.slice(this.workspacePrefix.length + 1));
    if (action.case === 'write') {
      const bytes = action.value.binaryContent ?? new TextEncoder().encode(action.value.content);
      if (action.value.createParents) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: action.value.overwrite ? 'w' : 'wx' });
      return {
        case: 'write' as const,
        value: {
          path: logicalPath,
          bytesWritten: BigInt(bytes.byteLength),
          fileVersion: createHash('sha256').update(bytes).digest('hex'),
        },
      };
    }
    const bytes = await readFile(path);
    const fileVersion = createHash('sha256').update(bytes).digest('hex');
    if (action.case === 'readImage') {
      return { case: 'readImage' as const, value: { path: logicalPath, data: bytes, fileVersion } };
    }
    const lines = bytes.toString('utf8').split('\n');
    const offset = action.value.offset ?? 1;
    const limit = action.value.limit ?? 2000;
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const hasMore = offset - 1 + selected.length < lines.length;
    return {
      case: 'read' as const,
      value: {
        path: logicalPath,
        content: selected.join('\n'),
        startLine: offset,
        endLine: selected.length === 0 ? offset - 1 : offset + selected.length - 1,
        hasMore,
        ...(hasMore ? { nextOffset: offset + selected.length } : {}),
        fileVersion,
        truncated: false,
      },
    };
  }
}

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    {
      type: 'response',
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      usage,
    },
  ];
}

class AgentProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly target: { path: string }) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    if (index === 0) {
      yield* response('', [
        { id: 'read-pasted-image', name: 'read_image', arguments: { path: this.target.path } },
      ]);
      return;
    }
    if (index === 1) {
      yield* response('image read');
      return;
    }
    if (index === 2) {
      yield* response('rerun complete');
      return;
    }
    throw new Error(`Unexpected Provider request ${index}.`);
  }
}

async function waitRun(database: DatabaseSync, runId: string): Promise<void> {
  await vi.waitFor(
    () => {
      const run = z
        .object({ status: z.string(), error_message: z.string().nullable() })
        .parse(
          database.prepare('SELECT status, error_message FROM runs WHERE run_id = ?').get(runId),
        );
      if (run.status === 'completed') return;
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        throw new Error(`Run ended as ${run.status}: ${run.error_message ?? ''}`);
      }
      throw new Error('Run is still active.');
    },
    { timeout: 10_000, interval: 20 },
  );
}

it('writes clipboard images into the unified sandbox without exposing env_id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-workspace-attachment-'));
  const target = { path: '', localPath: '' };
  const provider = new AgentProvider(target);
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId,
    accessToken,
    mainEnvironment: { envId: 'main', workspace: join(directory, 'workspace-1-primary') },
    mainEnvironmentOperations: (database) =>
      new LocalSandboxOperations(
        new EnvironmentStore(database),
        join(directory, 'workspace-1-primary'),
        join(directory, 'workspace-1-primary'),
      ),
    model: {
      provider,
      providerId: 'workspace-attachment-provider',
      modelId: 'workspace-attachment-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  try {
    seedReadyMainEnvironment(fixture.database, ownerId, 'main', fixture.mainEnvironment.workspace);
    const uploaded = await fixture.clients.attachments.uploadAttachment({
      clientActionId: 'paste-real-image',
      fileName: 'pixel.png',
      declaredMediaType: 'image/png',
      data: pngBytes,
      source: AttachmentSource.CLIPBOARD,
    });
    const attachment = uploaded.attachment;
    if (!attachment) throw new Error('The pasted image was not accepted.');
    expect(attachment.source).toBe(AttachmentSource.CLIPBOARD);
    expect(attachment).not.toHaveProperty('envId');
    target.path = `${fixture.mainEnvironment.workspace}/.kairos/attachments/${attachment.attachmentId}.png`;
    target.localPath = join(
      fixture.workspace,
      '.kairos',
      'attachments',
      `${attachment.attachmentId}.png`,
    );
    const created = await fixture.clients.thread.createThread({
      clientActionId: 'create-with-pasted-image',
      title: 'Pasted image',
      initialText: 'Read this pasted image.',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [attachment.attachmentId],
      initialClipboardAttachmentIds: [attachment.attachmentId],
    });
    if (!created.runId || !created.thread) throw new Error('The image Run was not created.');
    await waitRun(fixture.database, created.runId);
    const threadId = created.thread.threadId;

    expect(readFileSync(target.localPath)).toEqual(pngBytes);
    expect(provider.requests).toHaveLength(2);
    const firstUser = provider.requests[0]?.messages.find(
      (message) => message.role === 'user' && message.content_parts !== undefined,
    );
    if (firstUser?.role !== 'user') throw new Error('The first image message is missing.');
    expect(firstUser.content_parts).toEqual([
      {
        type: 'text',
        text: `Attachment: pixel.png\nOriginal sandbox file: ${target.path}\nUse read_image with this path and omit env_id to read the original file later.`,
      },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}`, detail: 'low' },
      },
    ]);
    const readCall = provider.requests[1]?.messages.find(
      (message) =>
        message.role === 'assistant' &&
        message.tool_calls?.some((call) => call.id === 'read-pasted-image'),
    );
    expect(JSON.stringify(readCall)).not.toContain('env_id');
    const toolMessage = provider.requests[1]?.messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'read-pasted-image',
    );
    if (toolMessage?.role !== 'tool') throw new Error('The read_image result is missing.');
    expect(toolMessage.content).toContain(target.path);
    expect(toolMessage.content_parts?.some((part) => part.type === 'image_url')).toBe(true);

    const user = z
      .object({ seq: z.number().int().positive() })
      .parse(
        fixture.database
          .prepare("SELECT seq FROM context_messages WHERE thread_id = ? AND role = 'user'")
          .get(threadId),
      );
    const link = z
      .object({
        source: z.string(),
        workspace_status: z.string(),
        env_id: z.string(),
        path: z.string(),
        operation_id: z.string(),
      })
      .parse(
        fixture.database
          .prepare(
            `SELECT source, workspace_status, env_id, path, operation_id
             FROM context_message_attachments WHERE message_seq = ?`,
          )
          .get(user.seq),
      );
    expect(link).toEqual({
      source: 'clipboard',
      workspace_status: 'completed',
      env_id: expect.any(String),
      path: target.path,
      operation_id: expect.any(String),
    });
    const write = z
      .object({
        operation_id: z.string(),
        action: z.string(),
        path: z.string(),
        binary_content: z.instanceof(Uint8Array),
      })
      .parse(
        fixture.database
          .prepare(
            'SELECT operation_id, action, path, binary_content FROM environment_operations WHERE operation_id = ?',
          )
          .get(link.operation_id),
      );
    expect(write.action).toBe('write');
    expect(write.path).toBe(target.path);
    expect(Buffer.from(write.binary_content).equals(pngBytes)).toBe(true);

    const recall = new SqlRecallEngine(fixture.database, {
      scope: { threadId, agentId: 'thread' },
      currentRunId: created.runId,
      includeDescendants: false,
      visibility: 'self',
    });
    const recalled = await recall.execute(
      `SELECT attachments_json FROM context WHERE seq = ${user.seq}`,
    );
    const attachmentsJson = recalled.rows[0]?.[0];
    expect(JSON.parse(String(attachmentsJson))).toEqual([
      {
        attachment_id: attachment.attachmentId,
        file_name: 'pixel.png',
        media_type: 'image/png',
        source: 'clipboard',
        workspace_required: 1,
        workspace_status: 'completed',
        path: target.path,
      },
    ]);
    expect(String(attachmentsJson)).not.toContain('env_id');
    expect(String(attachmentsJson)).not.toContain('base64');
    expect(String(attachmentsJson)).not.toContain('data:');
    const audit = z
      .object({ request_json: z.string() })
      .parse(
        fixture.database
          .prepare(
            'SELECT request_json FROM model_request_records WHERE thread_id = ? ORDER BY created_at LIMIT 1',
          )
          .get(threadId),
      );
    expect(audit.request_json).toContain(target.path);
    expect(audit.request_json).not.toContain('base64');
    expect(audit.request_json).not.toContain('data:');
    const storedRequest = JSON.parse(audit.request_json) as ModelRequest;
    const storedUser = storedRequest.messages.find(
      (message) => message.role === 'user' && message.content_parts !== undefined,
    );
    if (storedUser?.role !== 'user') throw new Error('The stored attachment reference is missing.');
    expect(
      storedUser.content_parts?.every((part) => part.type !== 'attachment' || !('env_id' in part)),
    ).toBe(true);

    writeFileSync(target.localPath, 'user modified this file after the first request');
    await fixture.clients.messages.reviseMessage({
      clientActionId: 'revise-pasted-image',
      threadId,
      messageId: z
        .object({ message_id: z.string() })
        .parse(
          fixture.database
            .prepare('SELECT message_id FROM context_messages WHERE seq = ?')
            .get(user.seq),
        ).message_id,
      text: 'Revise without replacing my file.',
    });
    const rerun = z
      .object({ run_id: z.string() })
      .parse(
        fixture.database
          .prepare('SELECT run_id FROM runs WHERE thread_id = ? AND rerun_from_message_seq = ?')
          .get(threadId, user.seq),
      );
    await waitRun(fixture.database, rerun.run_id);

    expect(provider.requests).toHaveLength(3);
    expect(readFileSync(target.localPath).toString()).toBe(
      'user modified this file after the first request',
    );
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM environment_operations WHERE action = 'write'")
        .get(),
    ).toEqual({ count: 1 });
    const rerunUser = provider.requests[2]?.messages.find(
      (message) =>
        message.role === 'user' &&
        stripMessageMeta(String(message.content)) === 'Revise without replacing my file.',
    );
    if (rerunUser?.role !== 'user') throw new Error('The Rerun image message is missing.');
    expect(JSON.stringify(rerunUser.content_parts)).toContain(target.path);
    expect(
      rerunUser.content_parts?.every((part) => part.type !== 'attachment' || !('env_id' in part)),
    ).toBe(true);
    expect(rerunUser.content_parts?.some((part) => part.type === 'image_url')).toBe(true);
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
