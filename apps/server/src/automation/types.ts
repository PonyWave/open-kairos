import type { EnvironmentPolicyInput } from '../sessions/environment-policies.js';
import type { RunError } from '../sessions/records.js';

export type AutomationSchedule =
  | { kind: 'cron'; expression: string; timeZone: string }
  | { kind: 'once'; runAt: string; timeZone: string };

export type AutomationTargetKind = 'main' | 'existing_thread' | 'new_task' | 'new_automation_only';

export interface AutomationTarget {
  kind: AutomationTargetKind;
  threadId?: string | undefined;
  environmentPolicy?: EnvironmentPolicyInput | undefined;
}

export type AutomationTrigger = 'scheduled' | 'run_now';
export type AutomationFireStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface AutomationRecord {
  seq: number;
  scheduleId: string;
  ownerId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  target: AutomationTarget;
  enabled: boolean;
  version: number;
  cursorAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AutomationFireRecord {
  seq: number;
  fireId: string;
  scheduleId: string;
  ownerId: string;
  trigger: AutomationTrigger;
  scheduleVersion: number;
  scheduledAt: string;
  actualAt: string;
  coalescedCount: number;
  prompt: string;
  targetKind: AutomationTargetKind;
  targetThreadId: string | null;
  inputId: string | null;
  acceptedRunId: string | null;
  consumedRunId: string | null;
  status: AutomationFireStatus;
  error: RunError | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CreateAutomationInput {
  ownerId: string;
  clientActionId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  target: AutomationTarget;
  enabled?: boolean | undefined;
}

export interface UpdateAutomationInput {
  ownerId: string;
  clientActionId: string;
  scheduleId: string;
  expectedVersion: bigint;
  name?: string | undefined;
  prompt?: string | undefined;
  schedule?: AutomationSchedule | undefined;
  target?: AutomationTarget | undefined;
  enabled?: boolean | undefined;
}
