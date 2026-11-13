import { fileURLToPath } from 'node:url';
import type { DaemonMessageInit } from '@kairos/contracts/device';
import { describe, expect, it } from 'vitest';
import { McpSessionHost } from './host.js';

const fixturePath = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url));

function collector() {
  const messages: DaemonMessageInit[] = [];
  return {
    messages,
    send: async (message: DaemonMessageInit) => {
      messages.push(message);
    },
  };
}

describe('McpSessionHost', () => {
  it('opens a stdio session, lists tools and calls them', async () => {
    const { messages, send } = collector();
    const host = new McpSessionHost({ send });
    await host.open({
      sessionId: 'session-1',
      serverName: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      env: {},
      url: '',
      headers: {},
    });
    await host.listTools({ sessionId: 'session-1', requestId: 'req-1' });
    const listed = messages.at(-1)?.payload;
    if (listed?.case !== 'mcpListToolsResult') throw new Error('unexpected payload');
    expect(listed.value.error).toBe('');
    const names = (listed.value.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual(['echo', 'fail']);

    await host.callTool({
      sessionId: 'session-1',
      requestId: 'req-2',
      toolName: 'echo',
      argumentsJson: JSON.stringify({ text: 'hello' }),
    });
    const called = messages.at(-1)?.payload;
    if (called?.case !== 'mcpCallToolResult') throw new Error('unexpected payload');
    expect(called.value.isError).toBe(false);
    expect(called.value.contentJson).toContain('echo:hello');

    await host.callTool({
      sessionId: 'session-1',
      requestId: 'req-3',
      toolName: 'fail',
      argumentsJson: '{}',
    });
    const failed = messages.at(-1)?.payload;
    if (failed?.case !== 'mcpCallToolResult') throw new Error('unexpected payload');
    expect(failed.value.isError).toBe(true);
    expect(failed.value.contentJson).toContain('intentional failure');

    await host.callTool({
      sessionId: 'session-1',
      requestId: 'req-4',
      toolName: 'missing',
      argumentsJson: '{}',
    });
    const missing = messages.at(-1)?.payload;
    if (missing?.case !== 'mcpCallToolResult') throw new Error('unexpected payload');
    expect(missing.value.isError).toBe(true);

    await host.closeAll();
  }, 30_000);

  it('reports an error for unknown sessions', async () => {
    const { messages, send } = collector();
    const host = new McpSessionHost({ send });
    await host.listTools({ sessionId: 'absent', requestId: 'req-x' });
    const listed = messages.at(-1)?.payload;
    if (listed?.case !== 'mcpListToolsResult') throw new Error('unexpected payload');
    expect(listed.value.error).toContain('not open');
  });
});
