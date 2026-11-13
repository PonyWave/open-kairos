import { DatabaseSync } from 'node:sqlite';
import { DeviceErrorCode, GrepMode, OperationStatus, OutputStream } from '@kairos/contracts/device';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sizedJpegBytes } from '../attachments/fixtures.js';
import { contextRecapMigrations } from '../storage/migrations.js';
import type {
  CreateEnvironmentOperationInput,
  EnvironmentOperationAction,
  EnvironmentOperationOutcome,
} from './environment-operation-store.js';
import { EnvironmentOperationStore } from './environment-operation-store.js';

const databases: DatabaseSync[] = [];
let now = new Date('2026-01-01T00:00:00.000Z');

function fixture(action: EnvironmentOperationAction = directoryAction()) {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec(`
    CREATE TABLE schema_migrations(
      namespace TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(namespace, version)
    );
    CREATE TABLE environments(env_id TEXT PRIMARY KEY);
    CREATE TABLE environment_device_bindings(device_binding_id TEXT PRIMARY KEY);
    INSERT INTO environments(env_id) VALUES ('env-1');
    INSERT INTO environment_device_bindings(device_binding_id) VALUES ('binding-1');
  `);
  const contextMigration = contextRecapMigrations.at(-1);
  if (!contextMigration) throw new Error('Context schema migration is missing.');
  database
    .prepare(
      'INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES (?, ?, ?, ?)',
    )
    .run('context_recap', contextMigration.version, contextMigration.name, now.toISOString());
  const store = new EnvironmentOperationStore(database, () => now);
  const input: CreateEnvironmentOperationInput = {
    operationId: 'operation-1',
    tenantId: 'tenant-1',
    envId: 'env-1',
    deviceId: 'device-1',
    deviceBindingId: 'binding-1',
    targetInstanceId: 'instance-1',
    ...(action.case === 'directoryCheck' ? {} : { bindingVersion: 7n }),
    action,
    expiresAt: new Date(now.getTime() + 60_000),
  };
  return { database, store, input };
}

function directoryAction(): EnvironmentOperationAction {
  return {
    case: 'directoryCheck',
    value: { path: '/workspace', loadWorkspace: true },
  };
}

function bashAction(command = 'printf hello'): EnvironmentOperationAction {
  return { case: 'bash', value: { command, cwd: '/workspace', timeoutSeconds: 120 } };
}

function directoryOutcome(): Extract<EnvironmentOperationOutcome, { case: 'directoryCheck' }> {
  return {
    case: 'directoryCheck',
    value: {
      normalizedPath: '/workspace',
      exists: true,
      directory: true,
      readable: true,
      writable: true,
      executable: true,
      os: 'linux',
      architecture: 'x86_64',
      capabilities: [5],
      resources: [],
    },
  };
}

function bashOutcome(endOffset = 0n): EnvironmentOperationOutcome {
  return {
    case: 'bash',
    value: { exitCode: 0, outputComplete: true, endOffset },
  };
}

function resultTarget(input: CreateEnvironmentOperationInput) {
  return {
    operationId: input.operationId,
    envId: input.envId,
    deviceBindingId: input.deviceBindingId,
    targetInstanceId: input.targetInstanceId,
    ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  now = new Date('2026-01-01T00:00:00.000Z');
});

describe('EnvironmentOperationStore', () => {
  it('persists every complete action and deduplicates by the full fingerprint', () => {
    const actions: EnvironmentOperationAction[] = [
      directoryAction(),
      {
        case: 'read',
        value: { path: 'notes.txt', cwd: '/workspace', offset: 2, limit: 20 },
      },
      {
        case: 'readImage',
        value: { path: 'pixel.png', cwd: '/workspace' },
      },
      {
        case: 'write',
        value: { path: 'notes.txt', cwd: '/workspace', content: '正文', overwrite: false },
      },
      {
        case: 'edit',
        value: {
          path: 'notes.txt',
          cwd: '/workspace',
          oldText: 'old',
          newText: 'new',
          expectedOccurrences: 2,
          expectedFileVersion: 'a'.repeat(64),
        },
      },
      bashAction(),
      {
        case: 'glob',
        value: { pattern: '**/*.ts', path: '/workspace/src', cwd: '/workspace', headLimit: 50 },
      },
      {
        case: 'grep',
        value: {
          pattern: 'needle',
          path: '/workspace',
          cwd: '/workspace',
          include: '*.ts',
          caseInsensitive: true,
          mode: GrepMode.FILES_WITH_MATCHES,
          lineNumbers: true,
          headLimit: 20,
          offset: 5,
        },
      },
    ];
    for (const [index, action] of actions.entries()) {
      const { database, store, input } = fixture(action);
      input.operationId = `operation-${index}`;
      expect(store.createIntent(input).created).toBe(true);
      expect(store.createIntent(input).created).toBe(false);
      expect(store.find(input.operationId)?.action).toEqual(action);
      expect(
        database
          .prepare(
            'SELECT action, path, cwd, binding_version, search_action FROM environment_operations WHERE operation_id = ?',
          )
          .get(input.operationId),
      ).toMatchObject({
        action:
          action.case === 'directoryCheck'
            ? 'directory_check'
            : action.case === 'readImage'
              ? 'read_image'
              : action.case === 'glob' || action.case === 'grep'
                ? 'read'
                : action.case,
        path: action.case === 'bash' ? null : action.value.path,
        cwd:
          action.case === 'directoryCheck' || action.case === 'directoryList'
            ? null
            : action.value.cwd,
        binding_version: action.case === 'directoryCheck' ? null : '7',
        search_action: action.case === 'glob' || action.case === 'grep' ? action.case : null,
      });
      expect(() =>
        store.createIntent({
          ...input,
          expiresAt: new Date(input.expiresAt.getTime() + 1),
        }),
      ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }));
    }
  });

  it('rejects expiration, conflicting parameters, and missing Agent binding versions', () => {
    const { store, input } = fixture();
    expect(() =>
      store.createIntent({
        ...input,
        operationId: 'expired',
        expiresAt: new Date(now.getTime() - 1),
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.OPERATION_EXPIRED }));
    store.createIntent(input);
    expect(() =>
      store.createIntent({
        ...input,
        action: { case: 'directoryCheck', value: { path: '/other', loadWorkspace: false } },
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }));
    const bash = fixture(bashAction());
    const missingVersion = { ...bash.input, operationId: 'missing-version' };
    delete missingVersion.bindingVersion;
    expect(() => bash.store.createIntent(missingVersion)).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.INVALID_MESSAGE }),
    );
  });

  it('persists directory results and post-processing before acknowledgement', () => {
    const { store, input } = fixture();
    store.createIntent(input);
    store.markSent(input.operationId, input.deviceBindingId, input.targetInstanceId);
    store.recordAccepted({
      ...resultTarget(input),
      status: OperationStatus.ACCEPTED,
      acceptedAt: now,
    });
    const result = {
      ...resultTarget(input),
      status: OperationStatus.COMPLETED,
      outcome: directoryOutcome(),
      observedAt: now,
    };
    expect(store.recordResult(result).postProcessedAt).toBeUndefined();
    expect(store.recordResult(result).resultStatus).toBe(OperationStatus.COMPLETED);
    expect(store.countActiveForBinding(input.deviceBindingId)).toBe(0);
    store.markPostProcessed(input.operationId);
    store.markResultAcknowledged(input.operationId);
    expect(store.find(input.operationId)).toMatchObject({
      deliveryState: 'sent',
      status: OperationStatus.COMPLETED,
      resultStatus: OperationStatus.COMPLETED,
      outcome: directoryOutcome(),
      outputComplete: true,
    });
    expect(store.find(input.operationId)?.resultAcknowledgedAt).toBeDefined();
    expect(() =>
      store.recordResult({
        ...result,
        outcome: {
          case: 'directoryCheck',
          value: { ...directoryOutcome().value, normalizedPath: '/other' },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }));
  });

  it('acknowledges Bash results only after output gaps are filled and deduplicates overlap', () => {
    const { database, store, input } = fixture(bashAction());
    store.createIntent(input);
    const target = resultTarget(input);
    expect(
      store.recordOutput({
        ...target,
        offset: 5n,
        stream: OutputStream.STDOUT,
        data: Buffer.from(' wor'),
      }),
    ).toBe(0n);
    store.recordResult({
      ...target,
      status: OperationStatus.COMPLETED,
      outcome: bashOutcome(11n),
      observedAt: now,
    });
    expect(store.find(input.operationId)).toMatchObject({ outputGap: true, outputComplete: false });
    store.markPostProcessed(input.operationId);
    expect(() => store.markResultAcknowledged(input.operationId)).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.INVALID_MESSAGE }),
    );

    const full = {
      ...target,
      offset: 0n,
      stream: OutputStream.STDOUT,
      data: Buffer.from('hello world'),
    };
    expect(store.recordOutput(full)).toBe(11n);
    expect(store.recordOutput(full)).toBe(11n);
    expect(() => store.recordOutput({ ...full, data: Buffer.from('hello World') })).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }),
    );
    expect(store.find(input.operationId)).toMatchObject({
      nextOffset: 11n,
      outputGap: false,
      outputComplete: true,
    });
    store.markResultAcknowledged(input.operationId);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM environment_operation_output_chunks').get(),
    ).toMatchObject({ count: 3 });
    const chunks = store.readOutputForTenant(input.tenantId, input.operationId, 0n);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))).toString()).toBe(
      'hello world',
    );
    const page = store.readOutputForTenant(input.tenantId, input.operationId, 6n, 3);
    expect(Buffer.concat(page.map((chunk) => Buffer.from(chunk.data))).toString()).toBe('wor');
    expect(page.at(-1)?.endOffset).toBe(9n);
  });

  it('does not treat a missing exit code as success', () => {
    const { store, input } = fixture(bashAction());
    store.createIntent(input);
    expect(() =>
      store.recordResult({
        ...resultTarget(input),
        status: OperationStatus.COMPLETED,
        outcome: { case: 'bash', value: { outputComplete: false } },
        observedAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.INVALID_MESSAGE }));
    expect(() =>
      store.recordResult({
        ...resultTarget(input),
        status: OperationStatus.FAILED,
        outcome: { case: 'bash', value: { exitCode: 0, outputComplete: false } },
        observedAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.INVALID_MESSAGE }));
  });

  it('keeps cancellation requested when delayed acceptance arrives', () => {
    const { store, input } = fixture(bashAction('sleep 30'));
    store.createIntent(input);
    store.requestCancel(input.tenantId, input.operationId, 'test cancellation');
    store.recordAccepted({
      ...resultTarget(input),
      status: OperationStatus.RUNNING,
      acceptedAt: now,
    });
    expect(store.find(input.operationId)).toMatchObject({
      status: OperationStatus.CANCEL_REQUESTED,
      cancelRequested: true,
      cancelReason: 'test cancellation',
    });
    expect(store.find(input.operationId)?.resultRecordedAt).toBeUndefined();
  });

  it('marks pending operations unknown on instance loss and preserves output evidence', () => {
    const { store, input } = fixture(bashAction());
    store.createIntent(input);
    store.recordOutput({
      ...resultTarget(input),
      offset: 0n,
      stream: OutputStream.STDOUT,
      data: Buffer.from('known'),
    });
    expect(store.countActiveForBinding(input.deviceBindingId)).toBe(1);
    const recovered = store.markInstanceLost(input.deviceBindingId, input.targetInstanceId);
    expect(recovered[0]).toMatchObject({
      status: OperationStatus.UNKNOWN,
      resultSource: 'recovery',
      outputGap: true,
      outputComplete: false,
      postProcessedAt: now.toISOString(),
    });
    expect(store.countActiveForBinding(input.deviceBindingId)).toBe(0);
    expect(
      Buffer.concat(
        store
          .readOutputForTenant(input.tenantId, input.operationId, 0n)
          .map((chunk) => Buffer.from(chunk.data)),
      ).toString(),
    ).toBe('known');
    expect(() =>
      store.recordOutput({
        ...resultTarget(input),
        offset: 5n,
        stream: OutputStream.STDOUT,
        data: Buffer.from('other'),
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }));
  });

  it('preserves saved device results while marking only unresolved operations unknown', () => {
    const { store, input } = fixture(bashAction());
    store.createIntent(input);
    const completedInput = { ...input, operationId: 'operation-2' };
    store.createIntent(completedInput);
    store.recordResult({
      ...resultTarget(completedInput),
      status: OperationStatus.COMPLETED,
      outcome: bashOutcome(0n),
      observedAt: now,
    });
    store.markPostProcessed(completedInput.operationId);
    const terminalRecordedAt = store.find(completedInput.operationId)?.resultRecordedAt;
    expect(() =>
      store.markInstanceLost(input.deviceBindingId, input.targetInstanceId),
    ).not.toThrow();
    expect(store.find(input.operationId)).toMatchObject({
      status: OperationStatus.UNKNOWN,
      resultSource: 'recovery',
    });
    expect(store.find(completedInput.operationId)).toMatchObject({
      status: OperationStatus.COMPLETED,
      resultSource: 'device',
      resultRecordedAt: terminalRecordedAt,
    });
    expect(store.find(completedInput.operationId)?.resultAcknowledgedAt).toBeUndefined();
  });
});

describe('EnvironmentOperationStore image results', () => {
  it('persists binary image outcomes and rejects a mismatched SHA-256', async () => {
    const { createHash } = await import('node:crypto');
    const action: EnvironmentOperationAction = {
      case: 'readImage',
      value: { path: 'pixel.png', cwd: '/workspace' },
    };
    const { database, store, input } = fixture(action);
    store.createIntent(input);
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const outcome: EnvironmentOperationOutcome = {
      case: 'readImage',
      value: {
        path: '/workspace/pixel.png',
        data,
        fileVersion: createHash('sha256').update(data).digest('hex'),
      },
    };
    expect(() =>
      store.recordResult({
        ...resultTarget(input),
        status: OperationStatus.COMPLETED,
        outcome: {
          case: 'readImage',
          value: { ...outcome.value, fileVersion: '0'.repeat(64) },
        },
        observedAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.INVALID_MESSAGE }));
    store.recordResult({
      ...resultTarget(input),
      status: OperationStatus.COMPLETED,
      outcome,
      observedAt: now,
    });
    expect(store.find(input.operationId)?.outcome).toMatchObject(outcome);
    expect(new EnvironmentOperationStore(database).find(input.operationId)?.outcome).toMatchObject(
      outcome,
    );
    expect(
      database
        .prepare('SELECT action, result_payload FROM environment_operations WHERE operation_id = ?')
        .get(input.operationId),
    ).toMatchObject({ action: 'read_image', result_payload: expect.any(Uint8Array) });
  });
});

describe('EnvironmentOperationStore maximum image fingerprints', () => {
  it('deduplicates and conflicts maximum image results without expanding bytes into entries', async () => {
    const { createHash } = await import('node:crypto');
    const action: EnvironmentOperationAction = {
      case: 'readImage',
      value: { path: 'maximum.jpg', cwd: '/workspace' },
    };
    const { database, store, input } = fixture(action);
    store.createIntent(input);
    const data = sizedJpegBytes(700_000);
    const outcome: EnvironmentOperationOutcome = {
      case: 'readImage',
      value: {
        path: '/workspace/maximum.jpg',
        data,
        fileVersion: createHash('sha256').update(data).digest('hex'),
      },
    };
    const result = {
      ...resultTarget(input),
      status: OperationStatus.COMPLETED,
      outcome,
      observedAt: now,
    };
    const entries = vi.spyOn(Object, 'entries');
    try {
      store.recordResult(result);
      store.recordResult(result);
      expect(entries.mock.calls.filter(([value]) => value instanceof Uint8Array)).toHaveLength(0);
      const fingerprint = database
        .prepare('SELECT result_fingerprint FROM environment_operations WHERE operation_id = ?')
        .get(input.operationId);
      expect(fingerprint).toEqual({ result_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const different = new Uint8Array([1, 2, 3]);
      expect(() =>
        store.recordResult({
          ...result,
          outcome: {
            case: 'readImage',
            value: {
              ...outcome.value,
              data: different,
              fileVersion: createHash('sha256').update(different).digest('hex'),
            },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }));
    } finally {
      entries.mockRestore();
    }
  });
});
