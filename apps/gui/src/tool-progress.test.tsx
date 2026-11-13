import type { Message, ToolCall } from '@kairos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { KairosClients } from './client.js';
import { ThreadProjector } from './thread-projection.js';
import { ToolOperationGroup } from './tool-call-groups.js';

function toolCall(id: string): ToolCall {
  return { toolCallId: id, toolName: 'mcp__demo__authenticate', argumentsJson: '{}' } as ToolCall;
}

function assistantMessage(call: ToolCall): Message {
  return {
    messageId: 'message-1',
    threadId: 'thread-1',
    seq: 1n,
    role: 'assistant',
    content: '',
    toolCalls: [call],
  } as unknown as Message;
}

describe('tool progress projection', () => {
  it('stores the latest progress per call and clears it when the tool result commits', () => {
    const projector = new ThreadProjector('thread-1');
    projector.applyWatchResponse({
      payload: {
        case: 'toolProgress',
        value: {
          threadId: 'thread-1',
          runId: 'run-1',
          agentId: 'thread',
          toolCallId: 'call-1',
          text: 'Discovering OAuth metadata…',
        },
      },
    } as never);
    projector.applyWatchResponse({
      payload: {
        case: 'toolProgress',
        value: {
          threadId: 'thread-1',
          runId: 'run-1',
          agentId: 'thread',
          toolCallId: 'call-1',
          text: 'Waiting for the OAuth callback',
          authorization: {
            serverName: 'demo',
            authorizationUrl: 'https://auth.example/authorize?state=abc',
            expiresAt: { seconds: 1_800_000_000n, nanos: 0 },
          },
        },
      },
    } as never);
    const progress = projector.state.toolProgress.get('call-1');
    expect(progress?.text).toBe('Waiting for the OAuth callback');
    expect(progress?.authorization?.authorizationUrl).toBe(
      'https://auth.example/authorize?state=abc',
    );
    expect(progress?.authorization?.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());

    projector.clearTransient();
    expect(projector.state.toolProgress.size).toBe(0);
  });

  it('ignores progress for non-root agents', () => {
    const projector = new ThreadProjector('thread-1');
    projector.applyWatchResponse({
      payload: {
        case: 'toolProgress',
        value: {
          threadId: 'thread-1',
          runId: 'run-1',
          agentId: 'subagent-x',
          toolCallId: 'call-2',
          text: 'hidden',
        },
      },
    } as never);
    expect(projector.state.toolProgress.size).toBe(0);
  });
});

describe('OAuth progress card', () => {
  it('renders the authorization link verbatim with a copy button', () => {
    const call = toolCall('call-1');
    const html = renderToStaticMarkup(
      <ToolOperationGroup
        message={assistantMessage(call)}
        calls={[call]}
        outcomes={new Map()}
        streaming={true}
        clients={{} as KairosClients}
        choices={{}}
        onExpandedChange={() => undefined}
        progressByCall={
          new Map([
            [
              'call-1',
              {
                toolCallId: 'call-1',
                text: 'Waiting',
                authorization: {
                  serverName: 'demo',
                  authorizationUrl: 'https://auth.example/authorize?state=abc',
                  expiresAt: new Date(1_800_000_000_000).toISOString(),
                },
              },
            ],
          ])
        }
      />,
    );
    expect(html).toContain('MCP server demo 需要授权');
    expect(html).toContain('href="https://auth.example/authorize?state=abc"');
    expect(html).toContain('复制授权链接');
    expect(html).toContain('有效期至');
    expect(html).not.toContain('等待工具返回结果');
  });

  it('shows the plain progress line without authorization data', () => {
    const call = toolCall('call-1');
    const html = renderToStaticMarkup(
      <ToolOperationGroup
        message={assistantMessage(call)}
        calls={[call]}
        outcomes={new Map()}
        streaming={true}
        clients={{} as KairosClients}
        choices={{}}
        onExpandedChange={() => undefined}
        progressByCall={new Map([['call-1', { toolCallId: 'call-1', text: 'Fetching pages…' }]])}
      />,
    );
    expect(html).toContain('Fetching pages…');
    expect(html).not.toContain('oauth-progress');
  });
});
