import { createRouterTransport } from '@connectrpc/connect';
import {
  AttachmentSchema,
  create,
  DelegationReferenceSchema,
  ListThreadCallPreviewsResponseSchema,
  ListThreadCardsResponseSchema,
  MessageRole,
  MessageSource,
  RunStatus,
  ThreadCallPreviewSchema,
  ThreadCallReferenceSchema,
  ThreadCardCursorSchema,
  ThreadCardSchema,
  ThreadCardSort,
  ThreadMessagePreviewSchema,
  ThreadSchema,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { delegationKey } from './delegation.js';
import { createThreadPreviewGateway } from './thread-preview-gateway.js';

const delegation = create(DelegationReferenceSchema, {
  sourceThreadId: 'main-1',
  sourceAgentId: 'thread',
  sourceToolCallId: 'call-1',
});
const reference = create(ThreadCallReferenceSchema, {
  delegation,
  sourceMessageId: 'source-message-1',
  sourceMessageSeq: 9n,
});
const thread = create(ThreadSchema, {
  threadId: 'task-1',
  title: '杭州行程',
  seq: 12n,
  threadType: ThreadType.TASK,
  createdAt: { seconds: 100n, nanos: 0 },
});
const previewAttachments = [
  create(AttachmentSchema, {
    attachmentId: 'attachment-1',
    fileName: '行程.txt',
    mediaType: 'text/plain',
    sizeBytes: 4n,
    sha256: 'a'.repeat(64),
  }),
  create(AttachmentSchema, {
    attachmentId: 'attachment-2',
    fileName: '地图.png',
    mediaType: 'image/png',
    sizeBytes: 8n,
    width: 2,
    height: 3,
    sha256: 'b'.repeat(64),
  }),
];
const replies = [
  create(ThreadMessagePreviewSchema, {
    messageId: 'reply-1',
    seq: 10n,
    role: MessageRole.ASSISTANT,
    text: '第一条真实回复',
    createdAt: { seconds: 101n, nanos: 0 },
  }),
  create(ThreadMessagePreviewSchema, {
    messageId: 'reply-2',
    seq: 11n,
    role: MessageRole.USER,
    source: MessageSource.THREAD_CALL,
    sourceThreadId: 'main-1',
    text: '',
    attachments: previewAttachments,
    createdAt: { seconds: 102n, nanos: 0 },
  }),
];
const cursor = create(ThreadCardCursorSchema, {
  sort: ThreadCardSort.CREATED_AT,
  sortAt: { seconds: 100n, nanos: 0 },
  threadSeq: 12n,
});

describe('M104 Thread preview gateway', () => {
  it('uses generated clients and preview attachment metadata without GetThread', async () => {
    const requestedSorts: ThreadCardSort[] = [];
    const requestedCursorSeqs: bigint[] = [];
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        listThreadCards(request) {
          requestedSorts.push(request.sort);
          if (request.cursor) requestedCursorSeqs.push(request.cursor.threadSeq);
          return create(ListThreadCardsResponseSchema, {
            cards: [
              create(ThreadCardSchema, {
                thread,
                lastMessageAt: { seconds: 102n, nanos: 0 },
                messages: replies,
                sourceCall: reference,
              }),
            ],
            nextCursor: cursor,
            hasMore: true,
          });
        },
      });
    });
    const gateway = createThreadPreviewGateway(createKairosClients({ transport }));

    const first = await gateway.listCards({ limit: 4, sort: 'createdAt', cursor: null });
    await gateway.listCards({ limit: 50, sort: 'createdAt', cursor: first.nextCursor });

    expect(requestedSorts).toEqual([ThreadCardSort.CREATED_AT, ThreadCardSort.CREATED_AT]);
    expect(requestedCursorSeqs).toEqual([12n]);
    expect(first.cards[0]?.thread.title).toBe('杭州行程');
    expect(first.cards[0]?.lastMessageAt?.seconds).toBe(102n);
    expect(first.cards[0]?.origin?.delegation).toEqual(delegation);
    expect(first.cards[0]?.origin?.sourceMessageId).toBe('source-message-1');
    expect(first.cards[0]?.replies.map((reply) => reply.content)).toEqual(['第一条真实回复', '']);
    expect(first.cards[0]?.replies[1]?.attachments?.map((item) => item.attachmentId)).toEqual([
      'attachment-1',
      'attachment-2',
    ]);
  });

  it('keeps exact delegation identity and call attachment metadata without GetThread', async () => {
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        listThreadCallPreviews(request) {
          expect(request.calls).toEqual([delegation]);
          return create(ListThreadCallPreviewsResponseSchema, {
            previews: [
              create(ThreadCallPreviewSchema, {
                call: reference,
                targetThreadId: thread.threadId,
                targetTitle: thread.title,
                status: RunStatus.RUNNING,
                replyCount: 5n,
                replies,
                responseMessageSeq: 20n,
              }),
            ],
          });
        },
      });
    });
    const gateway = createThreadPreviewGateway(createKairosClients({ transport }));
    const previews = await gateway.listCallPreviews([delegation]);
    const preview = previews.get(delegationKey(delegation));

    expect(preview?.target).toEqual({ threadId: 'task-1', title: '杭州行程' });
    expect(preview?.status).toBe(RunStatus.RUNNING);
    expect(preview?.responseMessageSeq).toBe(20n);
    expect(preview && preview.replyCount - BigInt(preview.replies.length)).toBe(3n);
    expect(preview?.replies[1]?.sourceThreadId).toBe('main-1');
    expect(preview?.replies[1]?.attachments?.[0]).toMatchObject({
      attachmentId: 'attachment-1',
      fileName: '行程.txt',
      sizeBytes: 4n,
    });
    expect(preview?.replies[1]?.attachments?.[1]).toMatchObject({
      attachmentId: 'attachment-2',
      mediaType: 'image/png',
      width: 2,
      height: 3,
    });
  });

  it('rejects inconsistent pagination instead of inventing a cursor', async () => {
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        listThreadCards() {
          return { cards: [], hasMore: true };
        },
      });
    });
    const gateway = createThreadPreviewGateway(createKairosClients({ transport }));
    await expect(
      gateway.listCards({ limit: 50, sort: 'lastMessageAt', cursor: null }),
    ).rejects.toThrow('分页位置');
  });
});
