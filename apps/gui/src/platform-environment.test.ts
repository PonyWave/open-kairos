import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  EnvironmentConnectionStatus,
  EnvironmentKind,
  EnvironmentSchema,
  EventService,
  ThreadSchema,
  ThreadService,
  ThreadSnapshotSchema,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { ThreadProjector, UnsupportedEventError } from './thread-projection.js';

const main = create(EnvironmentSchema, {
  envId: 'main',
  name: '主环境',
  kind: EnvironmentKind.SELF_HOSTED_MACOS,
  recommendedPwd: '/Users/pony/project',
});

describe('main environment projection', () => {
  it('reads a binary snapshot and environment events through the existing Thread stream', async () => {
    let reads = 0;
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        router.service(ThreadService, {
          getThread: () => {
            reads += 1;
            return {
              snapshot: { thread: { threadId: 'main-thread' }, mainEnvironment: main },
              throughSeq: 10n,
            };
          },
        });
        router.service(EventService, {
          async *watchThread() {
            for (const [index, connectionStatus] of [
              EnvironmentConnectionStatus.OFFLINE,
              EnvironmentConnectionStatus.ONLINE,
            ].entries()) {
              yield {
                payload: {
                  case: 'event',
                  value: {
                    eventId: `connection-${index}`,
                    threadId: 'main-thread',
                    seq: 11n + BigInt(index),
                    payload: {
                      case: 'mainEnvironmentChanged',
                      value: { ...main, connectionStatus },
                    },
                  },
                },
              };
            }
          },
        });
      }),
    });
    const projector = new ThreadProjector('main-thread');
    const response = await clients.thread.getThread({ threadId: 'main-thread' });
    if (!response.snapshot) throw new Error('Missing snapshot.');
    projector.applySnapshot(response.snapshot, response.throughSeq);
    expect(projector.state.snapshot?.mainEnvironment?.kind).toBe(EnvironmentKind.SELF_HOSTED_MACOS);
    const observed: EnvironmentConnectionStatus[] = [];
    let latest: WatchThreadResponse | undefined;
    for await (const event of clients.events.watchThread({
      threadId: 'main-thread',
      afterSeq: 10n,
    })) {
      projector.applyWatchResponse(event);
      latest = event;
      const status = projector.state.snapshot?.mainEnvironment?.connectionStatus;
      if (status !== undefined) observed.push(status);
    }
    expect(observed).toEqual([
      EnvironmentConnectionStatus.OFFLINE,
      EnvironmentConnectionStatus.ONLINE,
    ]);
    if (!latest) throw new Error('Missing event.');
    projector.applyWatchResponse(latest);
    expect(projector.state.throughSeq).toBe(12n);
    expect(reads).toBe(1);
  });

  it('rejects a missing envId or a non-device kind without advancing the cursor', () => {
    const projector = new ThreadProjector('main-thread');
    for (const environment of [
      create(EnvironmentSchema, { ...main, envId: '' }),
      create(EnvironmentSchema, { ...main, kind: EnvironmentKind.UNSPECIFIED }),
    ]) {
      expect(() =>
        projector.applySnapshot(
          create(ThreadSnapshotSchema, {
            thread: create(ThreadSchema, { threadId: 'main-thread' }),
            mainEnvironment: environment,
          }),
          10n,
        ),
      ).toThrow(UnsupportedEventError);
    }
    projector.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId: 'main-thread' }),
        mainEnvironment: main,
      }),
      10n,
    );
    for (const environment of [create(EnvironmentSchema, { ...main, envId: 'other-main' })]) {
      const event = create(WatchThreadResponseSchema, {
        payload: {
          case: 'event',
          value: {
            eventId: 'invalid',
            threadId: 'main-thread',
            seq: 11n,
            payload: { case: 'mainEnvironmentChanged', value: environment },
          },
        },
      });
      expect(() => projector.applyWatchResponse(event)).toThrow(UnsupportedEventError);
      expect(projector.state.throughSeq).toBe(10n);
      expect(projector.state.snapshot?.mainEnvironment).toBe(main);
    }
  });

  it('preserves the main environment across history pages and rejects a conflicting page', () => {
    const projector = new ThreadProjector('main-thread');
    projector.applySnapshotPage(
      create(ThreadSnapshotSchema, { thread: { threadId: 'main-thread' }, mainEnvironment: main }),
      10n,
    );
    projector.applySnapshotPage(create(ThreadSnapshotSchema, {}), 10n);
    expect(projector.state.snapshot?.mainEnvironment).toBe(main);
    expect(() =>
      projector.applySnapshotPage(
        create(ThreadSnapshotSchema, { mainEnvironment: { ...main, envId: 'another-main' } }),
        10n,
      ),
    ).toThrow(UnsupportedEventError);
    expect(projector.state.snapshot?.mainEnvironment).toBe(main);
  });
});
