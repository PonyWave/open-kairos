import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AttachmentService,
  AttachmentSource,
  BashLogService,
  CompactContextStatus,
  ContextService,
  EventService,
  InputMode,
  MessageService,
  ModelService,
  QueueService,
  RunExecutionMode,
  RunService,
  ThreadCardSort,
  ThreadService,
  validateCreateThreadRequest,
  validateDownloadAttachmentRequest,
  validateReadBashLogRequest,
  validateReloadResourcesRequest,
  validateUploadAttachmentRequest,
  WorkspaceService,
} from '@kairos/contracts';
import { AutomationService as AutomationManager } from '../automation/service.js';
import type { ModelConfigurationStatus } from '../config.js';
import type { DeviceChannel } from '../devices/channel.js';
import type { EnvironmentStore } from '../devices/environment-store.js';
import type { MainEnvironmentConfiguration } from '../devices/main-environment.js';
import type { DeviceBashStore } from '../devices/operation-store.js';
import { requirePositiveInteger, requireText, SessionError } from '../sessions/errors.js';
import { EventCursorError, watchThreadEvents } from '../sessions/events.js';
import type { RunCoordinator } from '../sessions/runtime.js';
import type { SessionStore } from '../sessions/store.js';
import {
  listSubagentCallViews,
  listThreadCallPreviews,
  listThreadCards,
  type ThreadCardSort as PreviewSort,
  threadCallPreviewBatchLimit,
} from '../sessions/thread-previews.js';
import type { SettingsStore } from '../settings/store.js';
import type { GuiAuthentication } from './auth.js';
import { registerAuthRoutes, requireOwner } from './auth.js';
import { registerAutomationRoutes } from './automation.js';
import {
  toAttachment,
  toAuditMessage,
  toInput,
  toRecap,
  toRun,
  toRunStatus,
  toThread,
  toThreadCallPreview,
  toThreadCard,
  toThreadCardCursor,
  toWatchEvent,
} from './convert.js';
import { type EnvironmentApiOptions, registerEnvironmentRoutes } from './environment.js';
import { asConnectError } from './errors.js';
import type { BashLogReader } from './logs.js';
import { registerSettingsRoutes } from './settings.js';
import { getThreadSnapshot } from './snapshot.js';
import { registerWorkspacesRoutes } from './workspaces.js';

function readThreadCardSort(value: ThreadCardSort): PreviewSort {
  switch (value) {
    case ThreadCardSort.UNSPECIFIED:
    case ThreadCardSort.LAST_MESSAGE_AT:
      return 'last_message_at';
    case ThreadCardSort.CREATED_AT:
      return 'created_at';
    default:
      throw new SessionError('invalid_argument', 'The Thread card sort is not supported.');
  }
}

function readCursorTime(value: { seconds: bigint; nanos: number } | undefined): string {
  if (
    !value ||
    !Number.isInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos > 999_999_999 ||
    value.nanos % 1_000_000 !== 0
  ) {
    throw new SessionError('invalid_argument', 'The Thread card cursor time is not valid.');
  }
  const milliseconds = value.seconds * 1000n + BigInt(value.nanos / 1_000_000);
  if (
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    milliseconds < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new SessionError('invalid_argument', 'The Thread card cursor time is not valid.');
  }
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime())) {
    throw new SessionError('invalid_argument', 'The Thread card cursor time is not valid.');
  }
  return date.toISOString();
}

export interface GuiApiOptions {
  store: SessionStore;
  coordinator: RunCoordinator;
  automations?: AutomationManager;
  operations: DeviceBashStore;
  logs: BashLogReader;
  modelStatus: ModelConfigurationStatus;
  settings?: SettingsStore;
  authentication: GuiAuthentication;
  deviceChannel?: DeviceChannel;
  environments?: EnvironmentStore;
  environmentDirectories?: EnvironmentApiOptions['directories'];
  deviceInstaller?: EnvironmentApiOptions['installer'];
  maxEventQueue?: number;
  maxEventBytes?: number;
  maxSnapshotBytes?: number;
  maxSnapshotRecords?: number;
  mainEnvironment?: MainEnvironmentConfiguration;
  isMainEnvironmentReady?: (tenantId: string) => boolean;
}

export function registerGuiRoutes(router: ConnectRouter, options: GuiApiOptions): void {
  const automations =
    options.automations ??
    new AutomationManager(options.store, {
      deliver: (input, runId) => options.coordinator.deliver(input, runId),
    });
  registerAuthRoutes(router, options.authentication);
  if (options.settings) registerSettingsRoutes(router, options.settings, options.authentication);
  registerAutomationRoutes(router, {
    automations,
    store: options.store,
    authentication: options.authentication,
    ...(options.maxSnapshotBytes === undefined && options.maxSnapshotRecords === undefined
      ? {}
      : {
          snapshot: {
            ...(options.maxSnapshotBytes === undefined
              ? {}
              : { maxBytes: options.maxSnapshotBytes }),
            ...(options.maxSnapshotRecords === undefined
              ? {}
              : { maxRecords: options.maxSnapshotRecords }),
          },
        }),
  });
  if (options.environments && options.mainEnvironment) {
    registerEnvironmentRoutes(router, {
      environments: options.environments,
      authentication: options.authentication,
      ...(options.environmentDirectories ? { directories: options.environmentDirectories } : {}),
      ...(options.deviceInstaller ? { installer: options.deviceInstaller } : {}),
      mainEnvironment: options.mainEnvironment,
    });
  }
  registerWorkspacesRoutes(router, {
    store: options.store,
    authentication: options.authentication,
  });
  const action = <T extends Record<string, unknown>>(
    ownerId: string,
    method: string,
    clientActionId: string,
    parameters: T,
  ) => ({ ownerId, method, clientActionId, parameters, ...parameters });
  const owner = (context: HandlerContext) => requireOwner(context, options.authentication);
  const handle = async <T>(
    clientActionId: string | undefined,
    work: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw asConnectError(error, clientActionId);
    }
  };

  router.service(AttachmentService, {
    uploadAttachment: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        validateUploadAttachmentRequest(request);
        const uploaded = options.store.attachments.upload({
          ownerId,
          clientActionId: request.clientActionId,
          fileName: request.fileName,
          declaredMediaType: request.declaredMediaType,
          bytes: request.data,
          source: request.source === AttachmentSource.CLIPBOARD ? 'clipboard' : 'file',
        });
        return {
          clientActionId: request.clientActionId,
          attachment: toAttachment(uploaded.attachment),
        };
      }),
    deleteAttachment: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const deleted = options.store.attachments.remove({
          ownerId,
          clientActionId: request.clientActionId,
          attachmentId: request.attachmentId,
        });
        return { clientActionId: request.clientActionId, ...deleted };
      }),
    downloadAttachment: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        validateDownloadAttachmentRequest(request);
        const downloaded = options.store.attachments.download({
          ownerId,
          attachmentId: request.attachmentId,
          ...(request.offset === undefined ? {} : { offset: request.offset }),
          limitBytes: request.limitBytes,
        });
        return {
          attachment: toAttachment(downloaded.attachment),
          data: downloaded.data,
          ...(downloaded.nextOffset === undefined ? {} : { nextOffset: downloaded.nextOffset }),
        };
      }),
  });

  router.service(ThreadService, {
    createThread: (request, context) =>
      handle(request.clientActionId, async () => {
        const ownerId = owner(context);
        validateCreateThreadRequest(request);
        const environmentPolicy = request.environmentPolicy;
        if (
          (request.initialText !== undefined || request.initialAttachmentIds.length > 0) &&
          request.initialMode !== InputMode.FOLLOW_UP &&
          request.initialMode !== InputMode.STEER
        ) {
          throw new SessionError('invalid_argument', 'Initial input mode must be specified.');
        }
        const created = options.store.createThread(
          action(ownerId, 'CreateThread', request.clientActionId, {
            title: request.title,
            autoSummarizeTitle: request.autoSummarizeTitle,
            ...(request.initialText === undefined ? {} : { initialText: request.initialText }),
            ...(request.initialMode === undefined
              ? {}
              : {
                  initialMode:
                    request.initialMode === InputMode.STEER
                      ? ('steer' as const)
                      : ('follow_up' as const),
                }),
            attachmentIds: [...request.initialAttachmentIds],
            clipboardAttachmentIds: [...request.initialClipboardAttachmentIds],
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
            ...(environmentPolicy
              ? {
                  environmentPolicy: {
                    allowedEnv: [...environmentPolicy.allowedEnv],
                  },
                }
              : {}),
          }),
        );
        if (!('input' in created)) {
          return { clientActionId: request.clientActionId, thread: toThread(created) };
        }
        if (request.autoSummarizeTitle && request.initialText?.trim()) {
          options.coordinator.scheduleThreadTitleSummary({
            ownerId,
            threadId: created.thread.threadId,
            prompt: request.initialText,
            expectedTitle: created.thread.title,
          });
        }
        await options.coordinator.deliver(created.input, created.runId);
        return {
          clientActionId: request.clientActionId,
          thread: toThread(created.thread),
          inputId: created.input.inputId,
          runId: created.runId,
        };
      }),
    getOrCreateMain: (_request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        return { thread: toThread(options.store.getOrCreateMainThread(ownerId)) };
      }),
    startNewMain: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        requireText(request.threadId, 'threadId', 200);
        const thread = options.store.startNewMain(
          action(ownerId, 'StartNewMain', request.clientActionId, {
            threadId: request.threadId,
          }),
        );
        return { clientActionId: request.clientActionId, thread: toThread(thread) };
      }),
    getThread: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        requireText(request.threadId, 'threadId', 200);
        const maxBytes =
          options.maxSnapshotBytes ??
          (options.maxEventBytes === undefined
            ? undefined
            : Math.max(1, Math.floor((options.maxEventBytes * 3) / 4)));
        return getThreadSnapshot(options.store, ownerId, request, {
          ...(options.mainEnvironment ? { mainEnvironment: options.mainEnvironment } : {}),
          mainEnvironmentReady: options.isMainEnvironmentReady?.(ownerId) ?? true,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          ...(options.maxSnapshotRecords === undefined
            ? {}
            : { maxRecords: options.maxSnapshotRecords }),
        });
      }),
    listThreads: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const limit = requirePositiveInteger(request.limit, 'limit', 100);
        const threads = options.store.listThreads(ownerId, request.afterSeq, limit + 1);
        const hasMore = threads.length > limit;
        const page = threads.slice(0, limit);
        return {
          threads: page.map(toThread),
          ...(hasMore && page.length > 0 ? { nextSeq: BigInt(page.at(-1)?.seq ?? 0) } : {}),
          hasMore,
        };
      }),
    listThreadCards: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const limit = requirePositiveInteger(request.limit, 'limit', 100);
        const sort = readThreadCardSort(request.sort);
        const result = listThreadCards(options.store, ownerId, {
          sort,
          limit,
          ...(request.cursor === undefined
            ? {}
            : {
                cursor: {
                  sort: readThreadCardSort(request.cursor.sort),
                  sortAt: readCursorTime(request.cursor.sortAt),
                  threadSeq: request.cursor.threadSeq,
                },
              }),
        });
        return {
          cards: result.cards.map(toThreadCard),
          ...(result.nextCursor === null
            ? {}
            : { nextCursor: toThreadCardCursor(result.nextCursor) }),
          hasMore: result.hasMore,
        };
      }),
    listThreadCallPreviews: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        if (request.calls.length > threadCallPreviewBatchLimit) {
          throw new SessionError(
            'invalid_argument',
            `A call preview request can contain at most ${threadCallPreviewBatchLimit} calls.`,
          );
        }
        const calls = request.calls.map((call) => ({
          sourceThreadId: requireText(call.sourceThreadId, 'sourceThreadId', 200),
          sourceAgentId: requireText(call.sourceAgentId, 'sourceAgentId', 200),
          sourceToolCallId: requireText(call.sourceToolCallId, 'sourceToolCallId', 200),
        }));
        return {
          previews: listThreadCallPreviews(options.store, ownerId, calls).map(toThreadCallPreview),
        };
      }),
    listSubagentCallViews: (request, context) =>
      handle(undefined, () => {
        if (request.calls.length > threadCallPreviewBatchLimit)
          throw new SessionError('invalid_argument', 'Too many Subagent calls.');
        const calls = request.calls.map((call) => ({
          sourceThreadId: requireText(call.sourceThreadId, 'sourceThreadId', 200),
          sourceAgentId: requireText(call.sourceAgentId, 'sourceAgentId', 200),
          sourceToolCallId: requireText(call.sourceToolCallId, 'sourceToolCallId', 200),
        }));
        return {
          views: listSubagentCallViews(options.store, owner(context), calls).map((view) => ({
            ...view,
            call: { ...view.call, sourceMessageSeq: BigInt(view.call.sourceMessageSeq) },
            ...(view.runId === null ? { runId: undefined } : { runId: view.runId }),
            status: toRunStatus(view.status),
            executionMode:
              view.executionMode === 'foreground'
                ? RunExecutionMode.FOREGROUND
                : RunExecutionMode.BACKGROUND,
          })),
        };
      }),
    renameThread: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const thread = options.store.renameThread(
          action(ownerId, 'RenameThread', request.clientActionId, {
            threadId: request.threadId,
            title: request.title,
          }),
        );
        return { clientActionId: request.clientActionId, thread: toThread(thread) };
      }),
  });

  router.service(MessageService, {
    sendMessage: (request, context) =>
      handle(request.clientActionId, async () => {
        const ownerId = owner(context);
        if (request.mode !== InputMode.FOLLOW_UP && request.mode !== InputMode.STEER) {
          throw new SessionError('invalid_argument', 'Input mode must be FOLLOW_UP or STEER.');
        }
        const sent = options.store.sendMessage(
          action(ownerId, 'SendMessage', request.clientActionId, {
            threadId: request.threadId,
            text: request.text,
            mode: request.mode === InputMode.STEER ? ('steer' as const) : ('follow_up' as const),
            attachmentIds: [...request.attachmentIds],
            clipboardAttachmentIds: [...request.clipboardAttachmentIds],
          }),
        );
        await options.coordinator.deliver(sent.input, sent.runId);
        return {
          clientActionId: request.clientActionId,
          inputId: sent.input.inputId,
          threadId: sent.input.threadId,
        };
      }),
    reviseMessage: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const { revision, run } = options.store.reviseMessage(
          action(ownerId, 'ReviseMessage', request.clientActionId, {
            threadId: request.threadId,
            messageId: request.messageId,
            text: request.text,
            ...(request.expectedRevisionId === undefined
              ? {}
              : { expectedRevisionId: request.expectedRevisionId }),
          }),
        );
        options.coordinator.schedule(run.threadId, run.runId);
        return {
          clientActionId: request.clientActionId,
          messageId: request.messageId,
          revisionId: revision.revisionId,
        };
      }),
  });

  router.service(QueueService, {
    editInput: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const input = options.store.editInput(
          action(ownerId, 'EditInput', request.clientActionId, {
            threadId: request.threadId,
            inputId: request.inputId,
            text: request.text,
            expectedVersion: request.expectedVersion,
          }),
        );
        return {
          clientActionId: request.clientActionId,
          inputId: input.inputId,
          version: BigInt(input.version),
        };
      }),
    removeInput: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const removed = options.store.removeInput(
          action(ownerId, 'RemoveInput', request.clientActionId, {
            threadId: request.threadId,
            inputId: request.inputId,
            expectedVersion: request.expectedVersion,
          }),
        );
        return {
          clientActionId: request.clientActionId,
          inputId: removed.input.inputId,
          queueVersion: BigInt(removed.queueVersion),
        };
      }),
    reorderInputs: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const reordered = options.store.reorderInputs(
          action(ownerId, 'ReorderInputs', request.clientActionId, {
            threadId: request.threadId,
            inputIds: request.inputIds,
            expectedVersion: request.expectedVersion,
          }),
        );
        return {
          clientActionId: request.clientActionId,
          inputs: reordered.inputs.map(toInput),
          queueVersion: BigInt(reordered.queueVersion),
        };
      }),
  });

  router.service(RunService, {
    cancelRun: (request, context) =>
      handle(request.clientActionId, async () => {
        const ownerId = owner(context);
        const run = options.store.requestCancelRun(
          action(ownerId, 'CancelRun', request.clientActionId, {
            threadId: request.threadId,
            runId: request.runId,
            reason: request.reason,
          }),
        );
        await options.coordinator.cancel(run, request.reason);
        return {
          clientActionId: request.clientActionId,
          runId: run.runId,
          status: toRun(run).status,
        };
      }),
    continueRun: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const run = options.store.continueRun(
          action(ownerId, 'ContinueRun', request.clientActionId, {
            threadId: request.threadId,
            runId: request.runId,
          }),
        );
        options.coordinator.schedule(run.threadId, run.runId);
        return {
          clientActionId: request.clientActionId,
          runId: run.runId,
          status: toRun(run).status,
        };
      }),
    rerun: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const run = options.store.rerun(
          action(ownerId, 'Rerun', request.clientActionId, {
            threadId: request.threadId,
            messageId: request.messageId,
          }),
        );
        options.coordinator.schedule(run.threadId, run.runId);
        return {
          clientActionId: request.clientActionId,
          runId: run.runId,
          status: toRunStatus(run.status),
        };
      }),
  });

  router.service(ContextService, {
    readContext: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const thread = options.store.getThread(ownerId, request.threadId);
        if (thread.archivedAt) {
          throw new SessionError('not_found', 'The archived main conversation is not available.');
        }
        if (thread.automationOnly) {
          throw new SessionError(
            'permission_denied',
            'Use the Automation history contract for an automation_only Thread.',
          );
        }
        const limit = requirePositiveInteger(request.limit, 'limit', 500);
        const messages = options.store
          .listContext(ownerId, request.threadId, request.agentId)
          .filter((message) => BigInt(message.seq) > request.afterSeq);
        const hasMore = messages.length > limit;
        const page = messages.slice(0, limit);
        return {
          messages: page.map(toAuditMessage),
          ...(hasMore && page.length > 0 ? { nextSeq: BigInt(page.at(-1)?.seq ?? 0) } : {}),
          hasMore,
        };
      }),
    readRecaps: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const thread = options.store.getThread(ownerId, request.threadId);
        if (thread.archivedAt) {
          throw new SessionError('not_found', 'The archived main conversation is not available.');
        }
        if (thread.automationOnly) {
          throw new SessionError(
            'permission_denied',
            'Use the Automation history contract for an automation_only Thread.',
          );
        }
        const limit = requirePositiveInteger(request.limit, 'limit', 500);
        const recaps = options.store
          .listRecaps(ownerId, request.threadId, request.agentId)
          .filter((recap) => BigInt(recap.cursor) > request.afterSeq);
        const hasMore = recaps.length > limit;
        const page = recaps.slice(0, limit);
        return {
          recaps: page.map(toRecap),
          ...(hasMore && page.length > 0 ? { nextSeq: BigInt(page.at(-1)?.cursor ?? 0) } : {}),
          hasMore,
        };
      }),
    compactContext: (request, context) =>
      handle(request.clientActionId, async () => {
        const ownerId = owner(context);
        requireText(request.threadId, 'threadId', 200);
        const result = await options.coordinator.compactContext({
          ownerId,
          threadId: request.threadId,
          clientActionId: request.clientActionId,
        });
        return {
          operationId: result.operationId,
          status:
            result.status === 'changed' ? CompactContextStatus.CHANGED : CompactContextStatus.NOOP,
          readThroughSeq: BigInt(result.readThroughSeq),
          recapIds: [...result.recapIds],
        };
      }),
  });

  router.service(WorkspaceService, {
    reloadResources: (request, context) =>
      handle(request.clientActionId, async () => {
        const ownerId = owner(context);
        validateReloadResourcesRequest(request);
        const result = await options.coordinator.reloadResources({
          ownerId,
          threadId: request.threadId,
          clientActionId: request.clientActionId,
        });
        return {
          snapshotId: result.snapshotId,
          changed: result.changed,
          resources: [...result.resources],
          added: [...result.added],
          updated: [...result.updated],
          removed: [...result.removed],
          ...(result.runtimeFingerprint === undefined
            ? {}
            : { runtimeFingerprint: result.runtimeFingerprint }),
          ...(result.runtimeChanged === undefined ? {} : { runtimeChanged: result.runtimeChanged }),
        };
      }),
  });

  router.service(BashLogService, {
    readBashLog: (request, context) =>
      handle(undefined, async () => {
        const ownerId = owner(context);
        validateReadBashLogRequest(request);
        return options.logs.read(ownerId, request);
      }),
  });

  router.service(ModelService, {
    getModelStatus: (_request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const selected = options.settings?.resolve(ownerId);
        const status = selected
          ? {
              providerId: selected.providerId,
              modelId: selected.modelId,
              contextCapacity: selected.contextWindowTokens,
              outputReserve: selected.outputReserveTokens,
              available: true,
              configurationErrors: [],
            }
          : options.modelStatus;
        const response = {
          providerId: status.providerId,
          modelId: status.modelId,
          contextCapacity: status.contextCapacity,
          outputReserve: status.outputReserve,
          available: status.available,
          configurationErrors: status.configurationErrors,
        };
        return response;
      }),
  });

  router.service(EventService, {
    watchThread: async function* (request, context) {
      try {
        const ownerId = owner(context);
        requireText(request.threadId, 'threadId', 200);
        const watched = options.store.getThread(ownerId, request.threadId);
        if (watched.archivedAt) {
          throw new SessionError('not_found', 'The archived main conversation is not available.');
        }
        if (watched.automationOnly) {
          automations.store.requireAutomationThread(
            ownerId,
            requireText(request.scheduleId ?? '', 'scheduleId', 200),
            request.threadId,
          );
        }
        for await (const event of watchThreadEvents(
          options.store,
          ownerId,
          request.threadId,
          request.afterSeq,
          context.signal,
          options.maxEventQueue,
        )) {
          const response = toWatchEvent(event);
          const bytes = Buffer.byteLength(
            JSON.stringify(response, (_key, value: unknown) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
          );
          if (bytes > (options.maxEventBytes ?? 1024 * 1024)) {
            throw new SessionError(
              'internal',
              'Thread event exceeds the configured message limit.',
            );
          }
          yield response;
        }
      } catch (error) {
        if (error instanceof EventCursorError) {
          throw new ConnectError(error.message, Code.OutOfRange, undefined, undefined, error);
        }
        if (context.signal.aborted) return;
        throw asConnectError(error);
      }
    },
  });
}
