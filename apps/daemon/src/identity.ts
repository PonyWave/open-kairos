import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type DaemonCapability = 'bash' | 'directory_check';

export interface DaemonIdentity {
  version: 2;
  envId: string;
  deviceId: string;
  deviceBindingId: string;
  deviceCredential: string;
  serverUrl: string;
  deviceName: string;
  grantedCapabilities: DaemonCapability[];
  daemonVersion: string;
}

export type DaemonIdentityErrorCode = 'INVALID_IDENTITY' | 'REAUTHORIZATION_REQUIRED';

export class DaemonIdentityError extends Error {
  constructor(
    readonly code: DaemonIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonIdentityError';
  }
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new DaemonIdentityError('INVALID_IDENTITY', `Daemon identity field ${field} is invalid.`);
  }
  return value;
}

export function validateServerUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Daemon Server URL must use WSS, except for loopback development.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Daemon Server URL must not contain credentials, query, or fragment.');
  }
  return url.toString();
}

function parseCapabilities(value: unknown): DaemonCapability[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new DaemonIdentityError(
      'INVALID_IDENTITY',
      'Daemon identity granted capabilities are invalid.',
    );
  }
  const capabilities = value.map((capability) => {
    if (capability !== 'bash' && capability !== 'directory_check') {
      throw new DaemonIdentityError(
        'INVALID_IDENTITY',
        'Daemon identity contains an unsupported granted capability.',
      );
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new DaemonIdentityError(
      'INVALID_IDENTITY',
      'Daemon identity granted capabilities must be unique.',
    );
  }
  return capabilities;
}

function parseIdentity(value: unknown): DaemonIdentity {
  if (typeof value !== 'object' || value === null) {
    throw new DaemonIdentityError('INVALID_IDENTITY', 'Daemon identity is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (record.version === 1) {
    throw new DaemonIdentityError(
      'REAUTHORIZATION_REQUIRED',
      'Daemon identity version 1 is not supported; reauthorize this installation.',
    );
  }
  if (record.version !== 2) {
    throw new DaemonIdentityError(
      'INVALID_IDENTITY',
      'Daemon identity version must be 2; reauthorization is required.',
    );
  }
  if (record.instanceId !== undefined || record.pairingCredential !== undefined) {
    throw new DaemonIdentityError(
      'INVALID_IDENTITY',
      'Daemon identity must not contain an instance ID or pairing credential.',
    );
  }
  return {
    version: 2,
    envId: requiredString(record.envId, 'envId', 200),
    deviceId: requiredString(record.deviceId, 'deviceId', 200),
    deviceBindingId: requiredString(record.deviceBindingId, 'deviceBindingId', 200),
    deviceCredential: requiredString(record.deviceCredential, 'deviceCredential', 512),
    serverUrl: validateServerUrl(requiredString(record.serverUrl, 'serverUrl', 2048)),
    deviceName: requiredString(record.deviceName, 'deviceName', 200),
    grantedCapabilities: parseCapabilities(record.grantedCapabilities),
    daemonVersion: requiredString(record.daemonVersion, 'daemonVersion', 100),
  };
}

export class DaemonIdentityStore {
  constructor(readonly path: string) {}

  load(): DaemonIdentity | undefined {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if ((statSync(this.path).mode & 0o077) !== 0) {
      throw new DaemonIdentityError(
        'INVALID_IDENTITY',
        'Daemon identity file permissions must be 0600.',
      );
    }
    try {
      return parseIdentity(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new DaemonIdentityError('INVALID_IDENTITY', 'Daemon identity JSON is invalid.');
      }
      throw error;
    }
  }

  save(identity: DaemonIdentity): void {
    const validated = parseIdentity(identity);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(validated)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporaryPath, this.path);
      chmodSync(this.path, 0o600);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
