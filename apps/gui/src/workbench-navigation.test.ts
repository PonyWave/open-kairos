import {
  create,
  EnvironmentKind,
  EnvironmentSchema,
  MessageSource,
  ThreadSnapshotSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  canLocateAgentOrigin,
  isMainShortcut,
  originElementId,
  pageFromLocation,
  shouldInvalidateTopicCards,
  shouldRefreshConversationPreviews,
} from './workbench-navigation.js';

describe('workbench navigation', () => {
  it('uses one topics link and rejects the removed board alias', () => {
    expect(pageFromLocation('?view=board')).toBeNull();
    expect(pageFromLocation('?view=topics')).toBe('directory');
    expect(pageFromLocation('?view=chat')).toBeNull();
  });

  it('recognizes Cmd/Ctrl+J without treating plain J as a shortcut', () => {
    expect(isMainShortcut({ key: 'j', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isMainShortcut({ key: 'J', metaKey: false, ctrlKey: true })).toBe(true);
    expect(isMainShortcut({ key: 'j', metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('uses stable origin ids', () => {
    expect(originElementId('call-1')).toBe('origin-call-1');
  });

  it('requires a complete Agent delegation origin', () => {
    expect(canLocateAgentOrigin(null)).toBe(false);
    expect(
      canLocateAgentOrigin({
        sourceThreadId: 'main-1',
        sourceAgentId: 'thread',
        sourceToolCallId: 'call-1',
      }),
    ).toBe(true);
  });

  it('invalidates cards for topic events and main Thread deliveries only', () => {
    expect(shouldInvalidateTopicCards('task-1', 'main-1', [])).toBe(true);
    expect(shouldInvalidateTopicCards('main-1', 'main-1', [])).toBe(false);
    expect(
      shouldInvalidateTopicCards('main-1', 'main-1', [{ source: MessageSource.THREAD_RESPONSE }]),
    ).toBe(true);
  });

  it('does not requery conversation previews when only the main environment changes', () => {
    const previous = create(ThreadSnapshotSchema, { thread: { threadId: 'main' } });
    const lifecycle = create(ThreadSnapshotSchema, {
      ...previous,
      mainEnvironment: create(EnvironmentSchema, {
        envId: 'main',
        kind: EnvironmentKind.SELF_HOSTED_LINUX,
      }),
    });
    expect(
      shouldRefreshConversationPreviews(previous, {
        ...previous,
        mainEnvironment: lifecycle.mainEnvironment,
      }),
    ).toBe(false);
    expect(shouldRefreshConversationPreviews(previous, { ...previous, messages: [] })).toBe(true);
    expect(shouldRefreshConversationPreviews(previous, { ...previous, runs: [] })).toBe(true);
    expect(shouldRefreshConversationPreviews(undefined, previous)).toBe(true);
  });
});
