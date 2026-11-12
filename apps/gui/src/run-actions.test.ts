import { createRouterTransport } from '@connectrpc/connect';
import { MessageService, RunService, RunStatus } from '@kairos/contracts';
import { expect, it } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore } from './actions.js';
import { createKairosClients } from './client.js';

it('retries a failed Run through ContinueRun without adding user input or rerunning tools', async () => {
  const continued: string[] = [];
  let sendCalls = 0;
  let rerunCalls = 0;
  const transport = createRouterTransport((router) => {
    router.service(RunService, {
      continueRun(request) {
        continued.push(request.runId);
        return {
          clientActionId: request.clientActionId,
          runId: request.runId,
          status: RunStatus.QUEUED,
        };
      },
      rerun(request) {
        rerunCalls += 1;
        return {
          clientActionId: request.clientActionId,
          runId: 'new-run',
          status: RunStatus.QUEUED,
        };
      },
    });
    router.service(MessageService, {
      sendMessage(request) {
        sendCalls += 1;
        return {
          clientActionId: request.clientActionId,
          inputId: 'unexpected',
          threadId: request.threadId,
        };
      },
    });
  });
  const actions = new ActionExecutor(
    new ClientActionStore(),
    createActionHandlers(createKairosClients({ transport })),
  );

  await actions.execute('continue-run:run-1', 'continueRun', {
    threadId: 'thread-1',
    runId: 'run-1',
  });

  expect(continued).toEqual(['run-1']);
  expect(sendCalls).toBe(0);
  expect(rerunCalls).toBe(0);
});
