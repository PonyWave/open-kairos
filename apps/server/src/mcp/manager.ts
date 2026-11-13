import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@kairos/agent-core';
import type { McpServerConfig } from './config.js';
import { qualifyMcpToolName } from './naming.js';

export interface McpToolInstance {
  envId: string;
  sessionId: string;
  toolName: string;
  description: string;
  inputSchemaJson: string;
}

interface McpSessionState {
  sessionId: string;
  envId: string;
  config: McpServerConfig;
  tools: Array<{ name: string; description: string; inputSchemaJson: string }>;
  ready: boolean;
  needsAuth: boolean;
}

export interface McpCredentialStore {
  getMcpOAuthCredentials(
    credentialKey: string,
  ): { accessToken: string; refreshToken: string; expiresAt: string | null } | undefined;
  saveMcpOAuthCredentials(input: {
    credentialKey: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  }): void;
  deleteMcpOAuthCredentials(credentialKey: string): void;
}

export interface McpChannel {
  openMcpSession(input: {
    envId: string;
    sessionId: string;
    serverName: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }): Promise<{ error: string; needsAuth: boolean }>;
  mcpAuthBegin(
    input: {
      envId: string;
      sessionId: string;
      requestId: string;
      serverName: string;
      url: string;
      headers: Record<string, string>;
      redirectUri: string;
      accessToken?: string;
      refreshToken?: string;
    },
    hooks: { onUrl: (url: string) => void },
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: bigint;
    error: string;
  }>;
  submitMcpAuthCode(input: {
    envId: string;
    sessionId: string;
    requestId: string;
    code: string;
  }): void;
  closeMcpSession(input: { envId: string; sessionId: string }): Promise<void>;
  mcpListTools(input: { envId: string; sessionId: string }): Promise<{
    tools: Array<{ name: string; description: string; inputSchemaJson: string }>;
    error: string;
  }>;
  mcpCallTool(input: {
    envId: string;
    sessionId: string;
    toolName: string;
    argumentsJson: string;
  }): Promise<{ contentJson: string; isError: boolean; error: string }>;
}

const REFRESH_INTERVAL_MS = 60_000;

export class McpManager {
  private readonly sessions = new Map<string, McpSessionState>();
  private readonly pendingAuths = new Map<
    string,
    { envId: string; sessionId: string; requestId: string }
  >();

  handleOAuthCallback(state: string, code: string): boolean {
    const pending = this.pendingAuths.get(state);
    if (pending === undefined) return false;
    this.pendingAuths.delete(state);
    this.options.channel.submitMcpAuthCode({
      envId: pending.envId,
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      code,
    });
    return true;
  }
  private readonly refreshing = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly knownOwners = new Set<string>();

  constructor(
    private readonly options: {
      configs: McpServerConfig[];
      channel: McpChannel;
      resolveMainEnvId: (ownerId: string) => string | undefined;
      credentials: McpCredentialStore;
      publicOrigin: string;
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined || this.options.configs.length === 0) return;
    this.timer = setInterval(() => {
      for (const ownerId of this.knownOwners) this.refresh(ownerId);
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const [key, session] of [...this.sessions]) {
      this.sessions.delete(key);
      const envId = (JSON.parse(key) as [string, string])[0];
      await this.options.channel
        .closeMcpSession({ envId, sessionId: session.sessionId })
        .catch(() => undefined);
    }
  }

  refresh(ownerId: string): void {
    this.knownOwners.add(ownerId);
    if (this.refreshing.has(ownerId)) return;
    this.refreshing.add(ownerId);
    void this.refreshNow(ownerId)
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => this.refreshing.delete(ownerId));
  }

  private async refreshNow(ownerId: string): Promise<void> {
    for (const config of this.options.configs) {
      const envId =
        config.env_id === 'main' ? this.options.resolveMainEnvId(ownerId) : config.env_id;
      if (envId === undefined) continue;
      const key = JSON.stringify([envId, config.name]);
      if (this.sessions.has(key)) continue;
      const sessionId = randomUUID();
      try {
        const headers = await this.sessionHeaders(envId, config);
        const opened = await this.options.channel.openMcpSession({
          envId,
          sessionId,
          serverName: config.name,
          transport: config.transport,
          ...(config.transport === 'stdio'
            ? { command: config.command, args: config.args, env: config.env }
            : { url: config.url, headers }),
        });
        if (opened.needsAuth) {
          this.sessions.set(key, {
            sessionId,
            envId,
            config,
            tools: [],
            ready: false,
            needsAuth: true,
          });
          continue;
        }
        if (opened.error.length > 0) {
          throw new Error(opened.error);
        }
        const listed = await this.options.channel.mcpListTools({ envId, sessionId });
        if (listed.error.length > 0) {
          throw new Error(listed.error);
        }
        this.sessions.set(key, {
          sessionId,
          envId,
          config,
          tools: listed.tools,
          ready: true,
          needsAuth: false,
        });
      } catch (error) {
        this.options.onError?.(
          error instanceof Error
            ? error
            : new Error(`MCP server "${config.name}" in "${envId}" failed to start.`),
        );
      }
    }
  }

  private credentialKey(config: McpServerConfig): string {
    return JSON.stringify([config.env_id, config.name]);
  }

  private async sessionHeaders(
    envId: string,
    config: McpServerConfig,
  ): Promise<Record<string, string>> {
    if (config.transport === 'stdio') return {};
    const base: Record<string, string> = { ...config.headers };
    const credentials = this.options.credentials.getMcpOAuthCredentials(this.credentialKey(config));
    if (credentials === undefined) return base;
    const expired =
      credentials.expiresAt !== null && Date.parse(credentials.expiresAt) <= Date.now() + 60_000;
    if (expired && credentials.refreshToken.length > 0) {
      const refreshed = await this.options.channel.mcpAuthBegin(
        {
          envId,
          sessionId: randomUUID(),
          requestId: randomUUID(),
          serverName: config.name,
          url: config.url,
          headers: base,
          redirectUri: `${this.options.publicOrigin}/mcp/oauth/callback`,
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
        },
        { onUrl: () => undefined },
      );
      if (refreshed.error.length === 0 && refreshed.accessToken.length > 0) {
        this.saveCredentials(envId, config, refreshed);
        base.authorization = `Bearer ${refreshed.accessToken}`;
        return base;
      }
      this.options.credentials.deleteMcpOAuthCredentials(this.credentialKey(config));
      return base;
    }
    if (!expired) base.authorization = `Bearer ${credentials.accessToken}`;
    return base;
  }

  private saveCredentials(
    _envId: string,
    config: McpServerConfig,
    tokens: { accessToken: string; refreshToken: string; expiresInSeconds: bigint },
  ): void {
    this.options.credentials.saveMcpOAuthCredentials({
      credentialKey: this.credentialKey(config),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt:
        tokens.expiresInSeconds > 0n
          ? new Date(Date.now() + Number(tokens.expiresInSeconds) * 1000).toISOString()
          : null,
    });
  }

  bridgedAgentTools(ownerId: string, allowedEnvIds: readonly string[]): AgentTool[] {
    this.refresh(ownerId);
    const allowed = new Set(allowedEnvIds);
    const byQualifiedName = new Map<string, McpToolInstance[]>();
    for (const [key, session] of this.sessions) {
      const envId = (JSON.parse(key) as [string, string])[0];
      if (!allowed.has(envId) || !session.ready) continue;
      for (const tool of session.tools) {
        const qualifiedName = qualifyMcpToolName(session.config.name, tool.name);
        const instances = byQualifiedName.get(qualifiedName) ?? [];
        instances.push({
          envId,
          sessionId: session.sessionId,
          toolName: tool.name,
          description: tool.description,
          inputSchemaJson: tool.inputSchemaJson,
        });
        byQualifiedName.set(qualifiedName, instances);
      }
    }
    const tools: AgentTool[] = [];
    for (const [qualifiedName, instances] of [...byQualifiedName].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      tools.push(this.bridgeTool(qualifiedName, instances));
    }
    const authByServer = new Map<string, McpSessionState[]>();
    for (const [key, session] of this.sessions) {
      const envId = (JSON.parse(key) as [string, string])[0];
      if (!allowed.has(envId) || !session.needsAuth) continue;
      const list = authByServer.get(session.config.name) ?? [];
      list.push(session);
      authByServer.set(session.config.name, list);
    }
    for (const [serverName, sessions] of [...authByServer].sort(([a], [b]) => a.localeCompare(b))) {
      tools.push(this.authenticateTool(serverName, sessions));
    }
    return tools;
  }

  private authenticateTool(serverName: string, sessions: McpSessionState[]): AgentTool {
    const single = sessions.length === 1;
    const first = sessions[0];
    if (first === undefined) throw new Error('An authenticate tool requires a session.');
    return {
      name: qualifyMcpToolName(serverName, 'authenticate'),
      description:
        `Complete the OAuth login for MCP server "${serverName}". ` +
        (single
          ? `The server is registered in environment "${first.envId}" (env_id: ${first.envId}). `
          : `The server is registered in environments: ${sessions
              .map((session) => session.envId)
              .join(', ')}; the env_id argument is required. `) +
        'Calling this tool prints an authorization URL for the user and waits (up to 15 minutes) ' +
        'for the browser authorization to complete. Show the URL to the user verbatim. On success ' +
        'the real MCP tools become available from the next execution.',
      parameters: single
        ? { type: 'object', additionalProperties: false, properties: {} }
        : {
            type: 'object',
            additionalProperties: false,
            required: ['env_id'],
            properties: {
              env_id: { type: 'string', enum: sessions.map((session) => session.envId) },
            },
          },
      validate: (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('authenticate arguments must be a JSON object.');
        }
        return value as Record<string, unknown>;
      },
      execute: async (input, { signal, progress }) => {
        signal.throwIfAborted();
        const envId = single
          ? first.envId
          : typeof (input as Record<string, unknown>).env_id === 'string'
            ? ((input as Record<string, unknown>).env_id as string)
            : undefined;
        if (envId === undefined) throw new Error('env_id is required for this authenticate tool.');
        const session = sessions.find((candidate) => candidate.envId === envId);
        if (session === undefined) {
          throw new Error(`MCP server "${serverName}" is not registered in "${envId}".`);
        }
        return this.runAuthentication(envId, session, progress);
      },
    };
  }

  private async runAuthentication(
    envId: string,
    session: McpSessionState,
    progress?: (update: {
      text: string;
      authorization?: { serverName: string; authorizationUrl: string; expiresAt: string };
    }) => void,
  ): Promise<string | { content: string; status: 'error' }> {
    const config = session.config;
    if (config.transport === 'stdio') {
      return { content: 'stdio MCP servers do not use OAuth.', status: 'error' };
    }
    const credentials = this.options.credentials.getMcpOAuthCredentials(this.credentialKey(config));
    if (credentials !== undefined) {
      const expired =
        credentials.expiresAt !== null && Date.parse(credentials.expiresAt) <= Date.now() + 60_000;
      if (!expired) {
        const reconnected = await this.reconnectAuthorized(envId, session);
        if (reconnected) {
          return `MCP server "${config.name}" already had valid OAuth credentials. Real tools are available from the next execution.`;
        }
      }
    }
    const requestId = randomUUID();
    const resultPromise = this.options.channel.mcpAuthBegin(
      {
        envId,
        sessionId: session.sessionId,
        requestId,
        serverName: config.name,
        url: config.url,
        headers: { ...config.headers },
        redirectUri: `${this.options.publicOrigin}/mcp/oauth/callback`,
        ...(credentials?.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
      },
      {
        onUrl: (url) => {
          try {
            const state = new URL(url).searchParams.get('state');
            if (state !== null) {
              this.pendingAuths.set(state, {
                envId,
                sessionId: session.sessionId,
                requestId,
              });
            }
          } catch {
            // The authorization URL is forwarded verbatim even when it cannot be parsed.
          }
          progress?.({
            text: `Open this URL in your browser to authorize "${config.name}":
${url}

Waiting for the OAuth callback (timeout 15 min).`,
            authorization: {
              serverName: config.name,
              authorizationUrl: url,
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          });
        },
      },
    );
    const result = await resultPromise;
    if (result.error.length > 0 || result.accessToken.length === 0) {
      return {
        content: `OAuth flow for MCP server "${config.name}" did not complete: ${result.error || 'no access token.'}`,
        status: 'error',
      };
    }
    this.saveCredentials(envId, config, result);
    const reconnected = await this.reconnectAuthorized(envId, session);
    if (!reconnected) {
      return {
        content: `MCP server "${config.name}" was authorized, but reconnecting with the new credentials failed. Try again later.`,
        status: 'error',
      };
    }
    return `MCP server "${config.name}" authenticated successfully. The real MCP tools replace this synthetic authenticate tool from the next execution.`;
  }

  private async reconnectAuthorized(envId: string, session: McpSessionState): Promise<boolean> {
    const config = session.config;
    try {
      const headers = await this.sessionHeaders(envId, config);
      const opened = await this.options.channel.openMcpSession({
        envId,
        sessionId: session.sessionId,
        serverName: config.name,
        transport: config.transport,
        ...(config.transport === 'stdio'
          ? { command: config.command, args: config.args, env: config.env }
          : { url: config.url, headers }),
      });
      if (opened.error.length > 0 || opened.needsAuth) return false;
      const listed = await this.options.channel.mcpListTools({
        envId,
        sessionId: session.sessionId,
      });
      if (listed.error.length > 0) return false;
      session.tools = listed.tools;
      session.ready = true;
      session.needsAuth = false;
      return true;
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }

  private bridgeTool(qualifiedName: string, instances: McpToolInstance[]): AgentTool {
    const first = instances[0];
    if (first === undefined) throw new Error('An MCP bridge requires at least one instance.');
    const single = instances.length === 1;
    const schema = safeSchema(first.inputSchemaJson);
    const envNote = single
      ? `[Registered by environment "${first.envId}" (env_id: ${first.envId}).]`
      : `[Registered by environments: ${instances
          .map((instance) => `${instance.envId} (env_id: ${instance.envId})`)
          .join(', ')}. The env_id argument is required.]`;
    const parameters = single
      ? schema
      : {
          ...schema,
          properties: {
            ...(typeof schema.properties === 'object' && schema.properties !== null
              ? schema.properties
              : {}),
            env_id: { type: 'string', enum: instances.map((instance) => instance.envId) },
          },
          required: [
            ...(Array.isArray(schema.required) ? (schema.required as unknown[]) : []),
            'env_id',
          ],
        };
    return {
      name: qualifiedName,
      description: `${envNote}\n${first.description}`.trim(),
      parameters,
      concurrent: true,
      validate: (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('MCP tool arguments must be a JSON object.');
        }
        return value as Record<string, unknown>;
      },
      execute: async (input, { signal }) => {
        signal.throwIfAborted();
        const args: Record<string, unknown> = { ...(input as Record<string, unknown>) };
        const envId = single
          ? first.envId
          : typeof args.env_id === 'string'
            ? args.env_id
            : undefined;
        if (envId === undefined) {
          throw new Error('env_id is required for this MCP tool.');
        }
        const instance = instances.find((candidate) => candidate.envId === envId);
        if (instance === undefined) {
          throw new Error(`MCP tool is not registered in environment "${envId}".`);
        }
        delete args.env_id;
        const result = await this.options.channel.mcpCallTool({
          envId,
          sessionId: instance.sessionId,
          toolName: instance.toolName,
          argumentsJson: JSON.stringify(args),
        });
        if (result.error.length > 0) {
          return { content: result.error, status: 'error' as const };
        }
        const text = flattenContent(result.contentJson);
        return result.isError
          ? { content: `MCP tool error: ${text}`, status: 'error' as const }
          : text;
      },
    };
  }
}

function safeSchema(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the default schema.
  }
  return { type: 'object', additionalProperties: true };
}

function flattenContent(contentJson: string): string {
  try {
    const parsed: unknown = JSON.parse(contentJson);
    if (!Array.isArray(parsed)) return contentJson;
    return parsed
      .map((item: unknown) => {
        if (typeof item !== 'object' || item === null) return String(item);
        const record = item as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') return record.text;
        if (record.type === 'resource' && typeof record.resource === 'object') {
          return `[resource content]`;
        }
        return `[${String(record.type ?? 'unknown')} content omitted]`;
      })
      .join('\n');
  } catch {
    return contentJson;
  }
}
