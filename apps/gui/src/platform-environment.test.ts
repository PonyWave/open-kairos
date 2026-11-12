import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  EnvironmentKind,
  EnvironmentSchema,
  EventService,
  PlatformLifecycleState,
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
  envId: 'platform-main',
  name: '主环境',
  kind: EnvironmentKind.PLATFORM_SANDBOX,
  lifecycleState: PlatformLifecycleState.PAUSED,
});

describe('platform environment projection', () => {
  it('reads a binary snapshot and lifecycle events through the existing Thread stream', async () => {
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
            for (const [index, lifecycleState] of [
              PlatformLifecycleState.RESUMING,
              PlatformLifecycleState.RUNNING,
              PlatformLifecycleState.PAUSING,
              PlatformLifecycleState.PAUSED,
            ].entries()) {
              yield {
                payload: {
                  case: 'event',
                  value: {
                    eventId: `lifecycle-${index}`,
                    threadId: 'main-thread',
                    seq: 11n + BigInt(index),
                    payload: {
                      case: 'mainEnvironmentChanged',
                      value: {
                        ...main,
                        lifecycleState,
                        ready: lifecycleState === PlatformLifecycleState.RUNNING,
                      },
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
    expect(projector.state.snapshot?.mainEnvironment?.lifecycleState).toBe(
      PlatformLifecycleState.PAUSED,
    );
    const observed: PlatformLifecycleState[] = [];
    let latest: WatchThreadResponse | undefined;
    for await (const event of clients.events.watchThread({
      threadId: 'main-thread',
      afterSeq: 10n,
    })) {
      projector.applyWatchResponse(event);
      latest = event;
      const state = projector.state.snapshot?.mainEnvironment?.lifecycleState;
      if (state !== undefined) observed.push(state);
    }
    expect(observed).toEqual([
      PlatformLifecycleState.RESUMING,
      PlatformLifecycleState.RUNNING,
      PlatformLifecycleState.PAUSING,
      PlatformLifecycleState.PAUSED,
    ]);
    if (!latest) throw new Error('Missing event.');
    projector.applyWatchResponse(latest);
    expect(projector.state.throughSeq).toBe(14n);
    expect(reads).toBe(1);
  });

  it('rejects unknown lifecycle states and a different environment without advancing the cursor', async () => {
    const projector = new ThreadProjector('main-thread');
    for (const lifecycleState of [PlatformLifecycleState.UNSPECIFIED, 99]) {
      const environment = create(EnvironmentSchema, { ...main });
      Reflect.set(environment, 'lifecycleState', lifecycleState);
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
    for (const environment of [
      create(EnvironmentSchema, { ...main, envId: 'other-tenant-main' }),
      create(EnvironmentSchema, { ...main, lifecycleState: PlatformLifecycleState.UNSPECIFIED }),
    ]) {
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
        create(ThreadSnapshotSchema, { mainEnvironment: { ...main, envId: 'another-platform' } }),
        10n,
      ),
    ).toThrow(UnsupportedEventError);
    expect(projector.state.snapshot?.mainEnvironment).toBe(main);
  });
});
