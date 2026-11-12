import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationService } from '../automation/service.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  buildMemoryDreamPrompt,
  ensureMemoryDreamAutomation,
  MEMORY_DREAM_AUTOMATION_NAME,
} from './dream.js';

const ownerId = 'memory-dream-owner';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-memory-dream-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  const store = new SessionStore(database);
  const service = new AutomationService(store, { deliver: async () => 'unused-run' });
  const options = {
    ownerId,
    enabled: true,
    directory: join(directory, 'memory'),
    indexMaxBytes: 10_240,
    timeZone: 'Asia/Shanghai',
  };
  return { database, store, service, options };
}

describe('memory dream automation', () => {
  it('seeds one automation-only cron automation and stays idempotent', () => {
    const { database, store, service, options } = fixture();
    try {
      ensureMemoryDreamAutomation(store, service, options);
      const listed = service.store.listAutomations(ownerId, 0n, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        name: MEMORY_DREAM_AUTOMATION_NAME,
        enabled: true,
        target: { kind: 'new_automation_only' },
        schedule: { kind: 'cron', expression: '23 3 * * *', timeZone: 'Asia/Shanghai' },
      });
      expect(listed[0]?.prompt).toContain(options.directory);
      expect(listed[0]?.prompt).toContain('STATE.json');
      expect(listed[0]?.nextFireAt).not.toBeNull();

      ensureMemoryDreamAutomation(store, service, options);
      expect(service.store.listAutomations(ownerId, 0n, 10)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('does not seed when disabled', () => {
    const { database, store, service, options } = fixture();
    try {
      ensureMemoryDreamAutomation(store, service, { ...options, enabled: false });
      expect(service.store.listAutomations(ownerId, 0n, 10)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('keeps a user disable and does not recreate after a user delete', () => {
    const { database, store, service, options } = fixture();
    try {
      ensureMemoryDreamAutomation(store, service, options);
      const created = service.store.listAutomations(ownerId, 0n, 10)[0];
      if (!created) throw new Error('The dream automation is missing.');
      service.update({
        ownerId,
        clientActionId: 'user-disable-dream',
        scheduleId: created.scheduleId,
        expectedVersion: BigInt(created.version),
        enabled: false,
      });
      ensureMemoryDreamAutomation(store, service, options);
      const disabled = service.store.listAutomations(ownerId, 0n, 10);
      expect(disabled).toHaveLength(1);
      expect(disabled[0]?.enabled).toBe(false);

      service.delete({
        ownerId,
        clientActionId: 'user-delete-dream',
        scheduleId: created.scheduleId,
        expectedVersion: BigInt(created.version + 1),
      });
      ensureMemoryDreamAutomation(store, service, options);
      expect(service.store.listAutomations(ownerId, 0n, 10)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('builds a prompt that names the watermark, recall and the byte limits', () => {
    const prompt = buildMemoryDreamPrompt('/data/memory', 10_240);
    expect(prompt).toContain('/data/memory/STATE.json');
    expect(prompt).toContain('recall');
    expect(prompt).toContain('10240 bytes');
    expect(prompt).toContain('lastConsolidatedAt');
  });
});
