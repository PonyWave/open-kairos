import { createRouterTransport } from '@connectrpc/connect';
import { type CreateThreadRequest, InputMode, ThreadService } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { applyDraftCompletion } from './action-completion.js';
import { createActionHandlers } from './action-handlers.js';
import type { StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import { planComposerSubmission } from './composer-submission.js';
import { loadDraft, saveDraft } from './drafts.js';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('new-topic sandbox workspace', () => {
  it('restores the text of old drafts while discarding obsolete environment choices', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'kairos.message-draft.v1.draft',
      JSON.stringify({
        id: 'saved',
        text: '继续原有要求',
        executionEnvironment: { envId: 'old-device', pwd: '/old-project' },
      }),
    );
    const restored = loadDraft(storage, 'draft');
    expect(restored).toEqual({ id: 'saved', text: '继续原有要求' });
    saveDraft(storage, 'draft', restored);
    expect(JSON.parse(storage.getItem('kairos.message-draft.v1.draft') ?? '{}')).not.toHaveProperty(
      'executionEnvironment',
    );
  });

  it('creates a topic and first input without fetching or selecting an environment', async () => {
    const requests: CreateThreadRequest[] = [];
    const clients = createKairosClients({
      transport: createRouterTransport((router) =>
        router.service(ThreadService, {
          createThread: (request) => {
            requests.push(request);
            return {};
          },
        }),
      ),
    });
    const submission = planComposerSubmission({
      draftId: 'sandbox-draft',
      text: '执行要求',
      mode: InputMode.FOLLOW_UP,
      busy: false,
      isTaskDraft: true,
      selectedThreadId: null,
      snapshotReady: false,
    });
    if (submission.kind !== 'action') throw new Error('Expected a task submission.');
    expect(submission.payload).not.toHaveProperty('executionEnvironment');
    await createActionHandlers(clients).createThread(submission.payload, 'create-sandbox-task');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.initialText).toBe('执行要求');
    expect(requests[0]?.environmentPolicy).toBeUndefined();
  });

  it('preserves an edited draft when an earlier creation result arrives', () => {
    expect(
      applyDraftCompletion(
        { id: 'pending', text: '新的要求' },
        {
          threadId: 'local:new-task',
          draftId: 'pending',
          text: '旧的要求',
        },
      ),
    ).toBeNull();
  });
});
