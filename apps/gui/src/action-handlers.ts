import { AutomationScheduleKind, AutomationTargetKind, InputMode } from '@kairos/contracts';
import { type ActionKind, ActionPayloadError } from './actions.js';
import { type AutomationTargetPayload, timestampFromIso } from './automation-model.js';
import type { KairosClients } from './client.js';

export type ActionHandler = (
  payload: unknown,
  clientActionId: string,
  signal?: AbortSignal,
) => Promise<unknown>;
export type ActionHandlers = Record<ActionKind, ActionHandler>;

export function createActionHandlers(clients: KairosClients): ActionHandlers {
  return {
    createThread: (payload, clientActionId, signal) => {
      const body = record(payload);
      if (
        body.initialText === undefined &&
        body.initialMode === undefined &&
        body.initialAttachmentIds === undefined
      ) {
        return clients.thread.createThread(
          {
            clientActionId,
            title: text(body, 'title'),
          },
          callOptions(signal),
        );
      }
      return clients.thread.createThread(
        {
          clientActionId,
          title: text(body, 'title'),
          autoSummarizeTitle: optionalBoolean(body, 'autoSummarizeTitle') ?? false,
          initialText: content(body, 'initialText'),
          initialMode: inputMode(body.initialMode),
          initialAttachmentIds: stringArray(body.initialAttachmentIds ?? []),
          initialClipboardAttachmentIds: stringArray(body.initialClipboardAttachmentIds ?? []),
        },
        callOptions(signal),
      );
    },
    renameThread: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.thread.renameThread(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          title: text(body, 'title'),
        },
        callOptions(signal),
      );
    },
    sendMessage: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.messages.sendMessage(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          text: content(body, 'text'),
          attachmentIds: stringArray(body.attachmentIds ?? []),
          clipboardAttachmentIds: stringArray(body.clipboardAttachmentIds ?? []),
          mode: inputMode(body.mode),
        },
        callOptions(signal),
      );
    },
    deleteAttachment: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.attachments.deleteAttachment(
        {
          clientActionId,
          attachmentId: text(body, 'attachmentId'),
        },
        callOptions(signal),
      );
    },
    reviseMessage: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.messages.reviseMessage(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          messageId: text(body, 'messageId'),
          text: content(body, 'text'),
          expectedRevisionId: nullableText(body, 'expectedRevisionId'),
        },
        callOptions(signal),
      );
    },
    editInput: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.queue.editInput(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          inputId: text(body, 'inputId'),
          text: content(body, 'text'),
          expectedVersion: uint64(body.expectedVersion),
        },
        callOptions(signal),
      );
    },
    removeInput: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.queue.removeInput(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          inputId: text(body, 'inputId'),
          expectedVersion: uint64(body.expectedVersion),
        },
        callOptions(signal),
      );
    },
    reorderInputs: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.queue.reorderInputs(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          inputIds: stringArray(body.inputIds),
          expectedVersion: uint64(body.expectedVersion),
        },
        callOptions(signal),
      );
    },
    cancelRun: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.runs.cancelRun(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          runId: text(body, 'runId'),
          reason: text(body, 'reason'),
        },
        callOptions(signal),
      );
    },
    continueRun: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.runs.continueRun(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          runId: text(body, 'runId'),
        },
        callOptions(signal),
      );
    },
    rerun: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.runs.rerun(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
          messageId: text(body, 'messageId'),
        },
        callOptions(signal),
      );
    },
    reloadResources: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.workspace.reloadResources(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
        },
        callOptions(signal),
      );
    },
    compactContext: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.context.compactContext(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
        },
        callOptions(signal),
      );
    },
    startNewMain: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.thread.startNewMain(
        {
          clientActionId,
          threadId: text(body, 'threadId'),
        },
        callOptions(signal),
      );
    },
    createAutomation: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.automations.createAutomation(
        {
          clientActionId,
          name: text(body, 'name'),
          prompt: content(body, 'prompt'),
          schedule: automationSchedule(body.schedule),
          target: automationTarget(body.target),
          enabled: optionalBoolean(body, 'enabled'),
        },
        callOptions(signal),
      );
    },
    updateAutomation: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.automations.updateAutomation(
        {
          clientActionId,
          scheduleId: text(body, 'scheduleId'),
          expectedVersion: uint64(body.expectedVersion),
          ...(body.name === undefined ? {} : { name: text(body, 'name') }),
          ...(body.prompt === undefined ? {} : { prompt: content(body, 'prompt') }),
          ...(body.schedule === undefined ? {} : { schedule: automationSchedule(body.schedule) }),
          ...(body.target === undefined ? {} : { target: automationTarget(body.target) }),
          ...(body.enabled === undefined ? {} : { enabled: optionalBoolean(body, 'enabled') }),
        },
        callOptions(signal),
      );
    },
    deleteAutomation: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.automations.deleteAutomation(
        {
          clientActionId,
          scheduleId: text(body, 'scheduleId'),
          expectedVersion: uint64(body.expectedVersion),
        },
        callOptions(signal),
      );
    },
    runAutomationNow: (payload, clientActionId, signal) => {
      const body = record(payload);
      return clients.automations.runAutomationNow(
        { clientActionId, scheduleId: text(body, 'scheduleId') },
        callOptions(signal),
      );
    },
  };
}

function automationSchedule(value: unknown): {
  kind: AutomationScheduleKind;
  cronExpression?: string;
  timeZone: string;
  runAt?: ReturnType<typeof timestampFromIso>;
} {
  if (value === undefined) invalidPayload();
  const body = record(value);
  const timeZone = text(body, 'timeZone');
  if (body.kind === AutomationScheduleKind.CRON) {
    return {
      kind: AutomationScheduleKind.CRON,
      cronExpression: text(body, 'cronExpression'),
      timeZone,
    };
  }
  if (body.kind === AutomationScheduleKind.ONCE) {
    return {
      kind: AutomationScheduleKind.ONCE,
      runAt: timestampFromIso(text(body, 'runAt')),
      timeZone,
    };
  }
  invalidPayload();
}

function automationTarget(value: unknown): {
  kind: AutomationTargetKind;
  threadId?: string;
  environmentPolicy?: { policyVersion: 1n; allowedEnv: string[] };
} {
  if (value === undefined) invalidPayload();
  const body = record(value);
  const kind = body.kind;
  if (
    kind !== AutomationTargetKind.MAIN &&
    kind !== AutomationTargetKind.EXISTING_THREAD &&
    kind !== AutomationTargetKind.NEW_TASK &&
    kind !== AutomationTargetKind.NEW_AUTOMATION_ONLY
  ) {
    invalidPayload();
  }
  const target: AutomationTargetPayload = {
    kind,
    ...(kind === AutomationTargetKind.EXISTING_THREAD ? { threadId: text(body, 'threadId') } : {}),
    ...(body.allowedEnv === undefined ? {} : { allowedEnv: stringArray(body.allowedEnv) }),
  };
  return {
    kind: target.kind,
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    ...(target.allowedEnv === undefined
      ? {}
      : { environmentPolicy: { policyVersion: 1n, allowedEnv: target.allowedEnv } }),
  };
}

function callOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function record(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalidPayload();
  return payload as Record<string, unknown>;
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) invalidPayload();
  return value;
}

function content(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') invalidPayload();
  return value;
}

function nullableText(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !value) invalidPayload();
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalidPayload();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    invalidPayload();
  }
  return [...value];
}

function inputMode(value: unknown): InputMode {
  if (value === InputMode.FOLLOW_UP) return InputMode.FOLLOW_UP;
  if (value === InputMode.STEER) return InputMode.STEER;
  invalidPayload();
}

function uint64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) invalidPayload();
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) invalidPayload();
  return parsed;
}

function invalidPayload(): never {
  throw new ActionPayloadError();
}
