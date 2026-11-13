import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from './config.js';
import { parseMcpServerConfigs } from './config.js';
import { type McpChannel, McpManager } from './manager.js';
import { qualifyMcpToolName, sanitizeMcpNamePart } from './naming.js';

describe('MCP naming', () => {
  it('qualifies and sanitizes tool names', () => {
    expect(sanitizeMcpNamePart('my server!')).toBe('my_server_');
    expect(qualifyMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    const long = qualifyMcpToolName('a'.repeat(60), 'b'.repeat(60));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toBe(qualifyMcpToolName('a'.repeat(60), 'b'.repeat(60)));
    expect(long).not.toBe(qualifyMcpToolName('a'.repeat(60), 'c'.repeat(60)));
  });
});

describe('MCP config', () => {
  it('parses stdio and remote servers and rejects duplicates', () => {
    const configs = parseMcpServerConfigs({
      servers: [
        { name: 'fs', transport: 'stdio', command: 'mcp-fs', args: ['--root', '/workspace'] },
        {
          name: 'web',
          transport: 'http',
          url: 'https://mcp.example/mcp',
          headers: { authorization: 'Bearer x' },
        },
      ],
    });
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ name: 'fs', env_id: 'main', transport: 'stdio' });
    expect(configs[1]).toMatchObject({ name: 'web', env_id: 'main', transport: 'http' });
    expect(() =>
      parseMcpServerConfigs({
        servers: [
          { name: 'fs', transport: 'stdio', command: 'a' },
          { name: 'fs', transport: 'stdio', command: 'b' },
        ],
      }),
    ).toThrow(/Duplicate MCP server/);
  });
});

function fakeChannel(behaviour?: {
  tools?: Array<{ name: string; description: string; inputSchemaJson: string }>;
  callResult?: { contentJson: string; isError: boolean; error: string };
  openResults?: Array<{ error: string; needsAuth: boolean }>;
  authResult?: {
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: bigint;
    error: string;
  };
  authUrl?: string;
}): McpChannel & {
  opened: string[];
  calls: Array<{ envId: string; toolName: string; argumentsJson: string }>;
  authBegins: Array<{ envId: string; requestId: string; refreshToken?: string }>;
  submittedCodes: Array<{ requestId: string; code: string }>;
} {
  const opened: string[] = [];
  const calls: Array<{ envId: string; toolName: string; argumentsJson: string }> = [];
  const authBegins: Array<{ envId: string; requestId: string; refreshToken?: string }> = [];
  const submittedCodes: Array<{ requestId: string; code: string }> = [];
  const openResults = [...(behaviour?.openResults ?? [])];
  return {
    opened,
    calls,
    authBegins,
    submittedCodes,
    openMcpSession: async (input) => {
      opened.push(`${input.envId}:${input.serverName}`);
      return openResults.shift() ?? { error: '', needsAuth: false };
    },
    closeMcpSession: async () => undefined,
    mcpListTools: async () => ({
      tools: behaviour?.tools ?? [
        {
          name: 'echo',
          description: 'Echo back',
          inputSchemaJson: JSON.stringify({
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          }),
        },
      ],
      error: '',
    }),
    mcpCallTool: async (input) => {
      calls.push({
        envId: input.envId,
        toolName: input.toolName,
        argumentsJson: input.argumentsJson,
      });
      return (
        behaviour?.callResult ?? {
          contentJson: JSON.stringify([{ type: 'text', text: 'echo result' }]),
          isError: false,
          error: '',
        }
      );
    },
    mcpAuthBegin: async (input, hooks) => {
      authBegins.push({
        envId: input.envId,
        requestId: input.requestId,
        ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
      });
      hooks.onUrl(behaviour?.authUrl ?? 'https://auth.example/authorize?state=state-1');
      return (
        behaviour?.authResult ?? {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresInSeconds: 3600n,
          error: '',
        }
      );
    },
    submitMcpAuthCode: (input) => {
      submittedCodes.push({ requestId: input.requestId, code: input.code });
    },
  };
}

function memoryCredentials() {
  const rows = new Map<
    string,
    { accessToken: string; refreshToken: string; expiresAt: string | null }
  >();
  return {
    rows,
    getMcpOAuthCredentials: (key: string) => rows.get(key),
    saveMcpOAuthCredentials: (input: {
      credentialKey: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: string | null;
    }) => {
      rows.set(input.credentialKey, {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
      });
    },
    deleteMcpOAuthCredentials: (key: string) => {
      rows.delete(key);
    },
  };
}

function managerWith(
  channel: McpChannel,
  configs: McpServerConfig[],
  credentials = memoryCredentials(),
): McpManager {
  return new McpManager({
    configs,
    channel,
    resolveMainEnvId: () => 'env-main',
    credentials,
    publicOrigin: 'https://kairos.example',
  });
}

describe('McpManager bridging', () => {
  it('bridges cached tools for allowed environments without env_id for a single instance', async () => {
    const channel = fakeChannel();
    const manager = managerWith(channel, [
      { name: 'fs', env_id: 'main', transport: 'stdio', command: 'mcp-fs', args: [], env: {} },
    ]);
    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tools = manager.bridgedAgentTools('owner-1', ['env-main']);
    expect(channel.opened).toEqual(['env-main:fs']);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.name).toBe('mcp__fs__echo');
    expect(tool?.description).toContain('Registered by environment "env-main"');
    expect(JSON.stringify(tool?.parameters)).not.toContain('env_id');
    expect(manager.bridgedAgentTools('owner-1', ['other-env'])).toHaveLength(0);
    const result = await tool?.execute(
      { text: 'hi' },
      {
        call: { id: 'c1', name: tool?.name ?? '', arguments: {} },
        signal: new AbortController().signal,
      },
    );
    expect(result).toBe('echo result');
    expect(channel.calls[0]).toMatchObject({
      envId: 'env-main',
      toolName: 'echo',
      argumentsJson: JSON.stringify({ text: 'hi' }),
    });
    await manager.close();
  });

  it('requires env_id when the same tool is registered in two environments', async () => {
    const channel = fakeChannel();
    const manager = new McpManager({
      configs: [
        { name: 'fs', env_id: 'main', transport: 'stdio', command: 'mcp-fs', args: [], env: {} },
        {
          name: 'fs',
          env_id: 'env-device',
          transport: 'stdio',
          command: 'mcp-fs',
          args: [],
          env: {},
        },
      ],
      channel,
      resolveMainEnvId: () => 'env-main',
      credentials: memoryCredentials(),
      publicOrigin: 'https://kairos.example',
    });
    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tools = manager.bridgedAgentTools('owner-1', ['env-main', 'env-device']);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.description).toContain('Registered by environments');
    expect(JSON.stringify(tool?.parameters)).toContain('env_id');
    const context = {
      call: { id: 'c1', name: tool?.name ?? '', arguments: {} },
      signal: new AbortController().signal,
    };
    await expect(tool?.execute({ text: 'hi' }, context)).rejects.toThrow('env_id is required');
    await tool?.execute({ text: 'hi', env_id: 'env-device' }, context);
    expect(channel.calls.at(-1)).toMatchObject({ envId: 'env-device', toolName: 'echo' });
    expect(channel.calls.at(-1)?.argumentsJson).toBe(JSON.stringify({ text: 'hi' }));
    await manager.close();
  });

  it('maps MCP error results to tool errors', async () => {
    const channel = fakeChannel({
      callResult: {
        contentJson: JSON.stringify([{ type: 'text', text: 'boom' }]),
        isError: true,
        error: '',
      },
    });
    const manager = managerWith(channel, [
      { name: 'fs', env_id: 'main', transport: 'stdio', command: 'mcp-fs', args: [], env: {} },
    ]);
    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tool = manager.bridgedAgentTools('owner-1', ['env-main'])[0];
    const result = await tool?.execute(
      { text: 'hi' },
      {
        call: { id: 'c1', name: tool?.name ?? '', arguments: {} },
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ status: 'error' });
    expect((result as { content: string }).content).toContain('MCP tool error: boom');
    await manager.close();
  });
});

describe('McpManager OAuth', () => {
  const httpConfig: McpServerConfig = {
    name: 'notion',
    env_id: 'main',
    transport: 'http',
    url: 'https://mcp.notion.example/mcp',
    headers: {},
  };

  it('registers an authenticate tool for needs-auth sessions and completes the flow', async () => {
    const channel = fakeChannel({
      openResults: [
        { error: '', needsAuth: true },
        { error: '', needsAuth: false },
      ],
    });
    const credentials = memoryCredentials();
    const manager = managerWith(channel, [httpConfig], credentials);
    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tools = manager.bridgedAgentTools('owner-1', ['env-main']);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.name).toBe('mcp__notion__authenticate');
    expect(tool?.description).toContain('env_id: env-main');
    expect(JSON.stringify(tool?.parameters)).not.toContain('env_id');

    const updates: Array<{ text: string; authorization?: { authorizationUrl: string } }> = [];
    const result = await tool?.execute(
      {},
      {
        call: { id: 'c1', name: tool?.name ?? '', arguments: {} },
        signal: new AbortController().signal,
        progress: (update) => updates.push(update),
      },
    );
    expect(result).toContain('authenticated successfully');
    expect(updates[0]?.authorization?.authorizationUrl).toBe(
      'https://auth.example/authorize?state=state-1',
    );
    expect(channel.authBegins).toHaveLength(1);
    expect(credentials.rows.get(JSON.stringify(['main', 'notion']))).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    expect(channel.opened).toEqual(['env-main:notion', 'env-main:notion']);

    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = manager.bridgedAgentTools('owner-1', ['env-main']);
    expect(after.map((candidate) => candidate.name)).toEqual(['mcp__notion__echo']);
    await manager.close();
  });

  it('routes the OAuth callback code to the pending authorization', async () => {
    const channel = fakeChannel({
      openResults: [{ error: '', needsAuth: true }],
      authResult: { accessToken: '', refreshToken: '', expiresInSeconds: 0n, error: 'cancelled' },
    });
    const manager = managerWith(channel, [httpConfig]);
    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tool = manager.bridgedAgentTools('owner-1', ['env-main'])[0];
    const execution = tool?.execute(
      {},
      {
        call: { id: 'c1', name: tool?.name ?? '', arguments: {} },
        signal: new AbortController().signal,
        progress: () => undefined,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.handleOAuthCallback('state-1', 'code-1')).toBe(true);
    expect(manager.handleOAuthCallback('state-1', 'code-1')).toBe(false);
    expect(manager.handleOAuthCallback('unknown', 'code-1')).toBe(false);
    const result = await execution;
    expect(result).toMatchObject({ status: 'error' });
    expect(channel.submittedCodes).toEqual([
      { requestId: channel.authBegins[0]?.requestId ?? '', code: 'code-1' },
    ]);
    await manager.close();
  });

  it('refreshes expired credentials before opening a session', async () => {
    const channel = fakeChannel({});
    const credentials = memoryCredentials();
    credentials.rows.set(JSON.stringify(['main', 'notion']), {
      accessToken: 'old-access',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const manager = managerWith(channel, [httpConfig], credentials);
    manager.refresh('owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.authBegins).toHaveLength(1);
    expect(channel.authBegins[0]?.refreshToken).toBe('refresh-1');
    expect(credentials.rows.get(JSON.stringify(['main', 'notion']))).toMatchObject({
      accessToken: 'access-1',
    });
    const tools = manager.bridgedAgentTools('owner-1', ['env-main']);
    expect(tools.map((candidate) => candidate.name)).toEqual(['mcp__notion__echo']);
    await manager.close();
  });
});
