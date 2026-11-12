import { type Message, MessageSource, type ThreadSnapshot } from '@kairos/contracts';

export type WorkbenchPage =
  | 'main'
  | 'directory'
  | 'thread'
  | 'draft'
  | 'devices'
  | 'settings'
  | 'automations'
  | 'automationThread';

export type AutomationRoute =
  | { page: 'automations'; scheduleId: string | null }
  | { page: 'automationThread'; scheduleId: string; threadId: string };

export function pageFromLocation(search: string): WorkbenchPage | null {
  const view = new URLSearchParams(search).get('view');
  return view === 'settings'
    ? 'settings'
    : view === 'devices'
      ? 'devices'
      : view === 'topics'
        ? 'directory'
        : view === 'automations'
          ? 'automations'
          : view === 'automation-thread'
            ? 'automationThread'
            : null;
}

export function automationRouteFromLocation(search: string): AutomationRoute | null {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  if (view !== 'automations' && view !== 'automation-thread') return null;
  const scheduleId = params.get('schedule');
  const threadId = params.get('thread');
  if (view === 'automation-thread' && scheduleId && threadId) {
    return { page: 'automationThread', scheduleId, threadId };
  }
  return { page: 'automations', scheduleId: view === 'automations' ? scheduleId : null };
}

export function workbenchLocation(
  page: string,
  threadId: string | null,
  mainThreadId: string,
  section: 'account' | 'models' | 'display',
  automationScheduleId: string | null = null,
  automationThreadId: string | null = null,
): string {
  if (page === 'settings') return `?view=settings&section=${section}`;
  if (page === 'devices') return '?view=devices';
  if (page === 'directory') return '?view=topics';
  if (page === 'draft') return '?view=draft';
  if (page === 'automations')
    return `?view=automations${automationScheduleId ? `&schedule=${encodeURIComponent(automationScheduleId)}` : ''}`;
  if (page === 'automationThread' && automationScheduleId && automationThreadId)
    return `?view=automation-thread&schedule=${encodeURIComponent(automationScheduleId)}&thread=${encodeURIComponent(automationThreadId)}`;
  if (page === 'thread' && threadId && threadId !== mainThreadId)
    return `?view=thread&thread=${encodeURIComponent(threadId)}`;
  return '';
}

export function isMainShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j';
}

export function originElementId(toolCallId: string): string {
  return `origin-${toolCallId}`;
}

export function canLocateAgentOrigin(
  origin: {
    sourceThreadId: string;
    sourceAgentId: string;
    sourceToolCallId: string;
  } | null,
): boolean {
  return Boolean(origin?.sourceThreadId && origin.sourceAgentId && origin.sourceToolCallId);
}

export function shouldInvalidateTopicCards(
  threadId: string,
  mainThreadId: string | null,
  messages: readonly Pick<Message, 'source'>[],
): boolean {
  return (
    threadId !== mainThreadId ||
    messages.some(
      (message) =>
        message.source === MessageSource.THREAD_RESPONSE ||
        message.source === MessageSource.THREAD_NOTIFICATION,
    )
  );
}

export function shouldRefreshConversationPreviews(
  previous: ThreadSnapshot | undefined,
  next: ThreadSnapshot,
): boolean {
  return (
    !previous ||
    previous.thread !== next.thread ||
    previous.messages !== next.messages ||
    previous.runs !== next.runs
  );
}
