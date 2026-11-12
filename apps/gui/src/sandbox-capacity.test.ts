import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  create,
  ErrorCode,
  MessageRole,
  MessageSchema,
  RunSchema,
  RunService,
  RunStatus,
  ToolResultStatus,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore } from './actions.js';
import { createKairosClients } from './client.js';
import { RunOutcomeCard } from './response-components.js';
import { projectConversation } from './response-projection.js';
import { projectToolOutcomes, toolOperationState } from './tool-group-projection.js';

describe('sandbox capacity failure', () => {
  it('shows one explicit capacity notice on the failed Run with a manual Continue control', () => {
    const run = create(RunSchema, {
      runId: 'capacity-run',
      threadId: 'main',
      agentId: 'thread',
      status: RunStatus.FAILED,
      error: {
        code: ErrorCode.SANDBOX_CAPACITY_EXHAUSTED,
        message: 'internal detail',
        retryable: true,
      },
    });
    const html = renderToStaticMarkup(
      createElement(RunOutcomeCard, { run, busy: false, onContinue: async () => {} }),
    );
    expect(html.match(/当前 sandbox 均被占用/g)).toHaveLength(1);
    expect(html).toContain('请稍后重试');
    expect(html).toContain('>重试</button>');
    expect(html).not.toContain('internal detail');
    expect(
      renderToStaticMarkup(
        createElement(RunOutcomeCard, { run, busy: true, onContinue: async () => {} }),
      ),
    ).toContain('disabled=""');
  });

  it('uses a new action id for another explicit attempt and the same id for an unknown reply', async () => {
    const actionIds: string[] = [];
    let loseNextReply = false;
    const clients = createKairosClients({
      transport: createRouterTransport((router) =>
        router.service(RunService, {
          continueRun: (request) => {
            actionIds.push(request.clientActionId);
            if (loseNextReply) {
              loseNextReply = false;
              throw new ConnectError('lost', Code.Unavailable);
            }
            return {
              clientActionId: request.clientActionId,
              runId: request.runId,
              status: RunStatus.QUEUED,
            };
          },
        }),
      ),
    });
    const effects = {
      upsertThread: () => {},
      selectThread: () => {},
      completeDraft: () => {},
      closeForm: () => {},
      showNotice: () => {},
    };
    const actions = new ActionExecutor(
      new ClientActionStore(),
      createActionHandlers(clients),
      (record, response) => completeGuiAction(record, response, effects),
    );
    const key = 'continue-run:capacity-run';
    const payload = { threadId: 'main', runId: 'capacity-run' };
    await actions.execute(key, 'continueRun', payload);
    expect(actionIds).toHaveLength(1);
    await actions.execute(key, 'continueRun', payload);
    expect(actionIds).toHaveLength(2);
    expect(actionIds[1]).not.toBe(actionIds[0]);
    loseNextReply = true;
    await actions.execute(key, 'continueRun', payload);
    expect(actions.state.failures[0]?.outcome).toBe('unknown');
    await actions.retry(key);
    expect(actionIds[3]).toBe(actionIds[2]);
    expect(actions.state.failures).toEqual([]);
  });

  it('keeps a tool capacity error local while the Run can still complete', () => {
    const message = create(MessageSchema, {
      messageId: 'tool-capacity',
      threadId: 'task',
      agentId: 'thread',
      role: MessageRole.TOOL,
      toolName: 'read',
      toolCallId: 'read-platform',
      content: '当前 sandbox 均被占用，暂时无法启动环境，请稍后重试。',
      toolStatus: ToolResultStatus.ERROR,
      toolError: { code: 'sandbox_capacity_exhausted', message: 'capacity exhausted' },
    });
    const outcomes = projectToolOutcomes([message]);
    expect(toolOperationState({ toolName: 'read' }, outcomes.get('read-platform'), false)).toBe(
      'failed',
    );
    const items = projectConversation({
      threadId: 'task',
      messages: [message],
      transientResponses: [],
      runs: [
        create(RunSchema, {
          runId: 'self-hosted-run',
          threadId: 'task',
          agentId: 'thread',
          status: RunStatus.COMPLETED,
        }),
      ],
    });
    expect(items.every((item) => item.kind === 'message')).toBe(true);
  });
});
