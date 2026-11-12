import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  InputMode,
  InputSchema,
  InputStatus,
  ListThreadCardsResponseSchema,
  MessageRole,
  MessageSource,
  ThreadCardSchema,
  ThreadMessagePreviewSchema,
  ThreadSchema,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { projectQueuedInputs } from './conversation.js';
import { createThreadPreviewGateway } from './thread-preview-gateway.js';
import { ThreadDirectory } from './workbench.js';
import {
  automationRouteFromLocation,
  pageFromLocation,
  workbenchLocation,
} from './workbench-navigation.js';

describe('Automation navigation and ordinary-list isolation', () => {
  it('restores detail and hidden-history locations and clears them on ordinary navigation', () => {
    expect(pageFromLocation('?view=automations&schedule=schedule-1')).toBe('automations');
    expect(pageFromLocation('?view=automation-thread&schedule=schedule-1&thread=hidden-1')).toBe(
      'automationThread',
    );
    expect(
      automationRouteFromLocation('?view=automation-thread&schedule=schedule-1&thread=hidden-1'),
    ).toEqual({ page: 'automationThread', scheduleId: 'schedule-1', threadId: 'hidden-1' });
    expect(automationRouteFromLocation('?view=automation-thread')).toEqual({
      page: 'automations',
      scheduleId: null,
    });
    expect(workbenchLocation('automations', null, 'main', 'account', 'schedule / 1')).toBe(
      '?view=automations&schedule=schedule%20%2F%201',
    );
    expect(
      workbenchLocation('automationThread', null, 'main', 'account', 'schedule-1', 'hidden / 1'),
    ).toBe('?view=automation-thread&schedule=schedule-1&thread=hidden%20%2F%201');

    const directory = new ThreadDirectory({ mainThreadId: 'main' });
    directory.openAutomations('schedule-1');
    expect(directory.state).toMatchObject({
      page: 'automations',
      automationScheduleId: 'schedule-1',
    });
    directory.openAutomationThread('schedule-1', 'hidden-1');
    expect(directory.state).toMatchObject({
      page: 'automationThread',
      automationScheduleId: 'schedule-1',
      automationThreadId: 'hidden-1',
    });
    directory.showMain();
    expect(directory.state).toMatchObject({
      page: 'thread',
      automationScheduleId: null,
      automationThreadId: null,
    });
  });

  it('keeps automation-only Threads and inputs out of ordinary directories and queues', () => {
    const directory = new ThreadDirectory({ mainThreadId: 'main' });
    const ordinary = create(ThreadSchema, {
      threadId: 'task-1',
      title: '普通话题',
      seq: 1n,
      threadType: ThreadType.TASK,
    });
    const hidden = create(ThreadSchema, {
      ...ordinary,
      threadId: 'hidden-1',
      title: '定时专属',
      automationOnly: true,
    });
    directory.upsertThread(ordinary);
    directory.upsertThread(hidden);
    expect(directory.state.threads.map((thread) => thread.threadId)).toEqual(['task-1']);

    const input = (inputId: string, source: MessageSource, position: bigint) =>
      create(InputSchema, {
        inputId,
        threadId: 'main',
        text: inputId,
        mode: InputMode.FOLLOW_UP,
        status: InputStatus.QUEUED,
        source,
        position,
        version: 1n,
      });
    const queued = projectQueuedInputs([
      input('automation-input', MessageSource.AUTOMATION, 1n),
      input('user-input', MessageSource.USER, 2n),
    ]);
    expect(queued.map((item) => item.inputId)).toEqual(['user-input']);
  });

  it('accepts Automation sources in ordinary task-card previews', async () => {
    const thread = create(ThreadSchema, {
      threadId: 'task-1',
      title: '定时创建的普通话题',
      seq: 1n,
      threadType: ThreadType.TASK,
    });
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        listThreadCards() {
          return create(ListThreadCardsResponseSchema, {
            cards: [
              create(ThreadCardSchema, {
                thread,
                messages: [
                  create(ThreadMessagePreviewSchema, {
                    messageId: 'message-1',
                    seq: 1n,
                    role: MessageRole.USER,
                    source: MessageSource.AUTOMATION,
                    text: '定时 prompt',
                  }),
                ],
              }),
            ],
            hasMore: false,
          });
        },
      });
    });
    const gateway = createThreadPreviewGateway(createKairosClients({ transport }));
    const page = await gateway.listCards({ limit: 4, sort: 'lastMessageAt', cursor: null });
    expect(page.cards[0]?.replies[0]).toMatchObject({
      source: MessageSource.AUTOMATION,
      content: '定时 prompt',
    });
  });
});
