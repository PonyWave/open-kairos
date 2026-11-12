import type { AutomationService } from '../automation/service.js';
import type { SessionStore } from '../sessions/store.js';
import { MEMORY_INDEX_FILE, MEMORY_STATE_FILE, MEMORY_TOPIC_MAX_BYTES } from './types.js';

export const MEMORY_DREAM_CLIENT_ACTION_ID = 'builtin-memory-dream-v1';
export const MEMORY_DREAM_AUTOMATION_NAME = '记忆整理 (dream)';
export const MEMORY_DREAM_CRON_EXPRESSION = '23 3 * * *';

export function buildMemoryDreamPrompt(directory: string, indexMaxBytes: number): string {
  return `Nightly memory consolidation (dream). You maintain the long-term memory wiki at ${directory} for this user. Work only inside that directory.

Steps:
1. Ensure the directory exists (mkdir -p ${directory}).
2. Read ${directory}/${MEMORY_STATE_FILE} if present and note lastConsolidatedAt (null when missing).
3. Use the recall tool to find Threads with last_message_at after lastConsolidatedAt (all when null): query the thread table, then read their recap rows first and context rows only where recaps are insufficient.
4. Distill durable user-level knowledge from that activity: preferences, long-term decisions, project facts and recurring workflows. Ignore transient task details and never store credentials or secrets. Skip anything the current wiki already covers.
5. Update the wiki: revise or create topic pages (<slug>.md, each under ${MEMORY_TOPIC_MAX_BYTES} bytes), then rewrite ${MEMORY_INDEX_FILE} as a concise one-line-per-entry index pointing to the topic pages, under ${indexMaxBytes} bytes. Merge or remove stale entries that newer activity supersedes.
6. Write ${directory}/${MEMORY_STATE_FILE} with {"lastConsolidatedAt": "<current ISO 8601 time>", "threadsReviewed": <count>} even when nothing else changed.
7. If ${directory}/.git exists, commit all changes there with a one-line message.

If there is no new activity since lastConsolidatedAt, only update ${MEMORY_STATE_FILE} and finish. Reply with one line summarizing what changed, or "no changes".`;
}

export function ensureMemoryDreamAutomation(
  sessions: SessionStore,
  automations: AutomationService,
  options: {
    ownerId: string;
    enabled: boolean;
    directory: string;
    indexMaxBytes: number;
    timeZone?: string;
  },
): void {
  if (!options.enabled) return;
  const seeded = sessions.database
    .prepare('SELECT 1 AS present FROM client_actions WHERE owner_id = ? AND client_action_id = ?')
    .get(options.ownerId, MEMORY_DREAM_CLIENT_ACTION_ID);
  if (seeded !== undefined) return;
  automations.create({
    ownerId: options.ownerId,
    clientActionId: MEMORY_DREAM_CLIENT_ACTION_ID,
    name: MEMORY_DREAM_AUTOMATION_NAME,
    prompt: buildMemoryDreamPrompt(options.directory, options.indexMaxBytes),
    schedule: {
      kind: 'cron',
      expression: MEMORY_DREAM_CRON_EXPRESSION,
      timeZone: options.timeZone ?? systemTimeZone(),
    },
    target: { kind: 'new_automation_only' },
    enabled: true,
  });
}

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
