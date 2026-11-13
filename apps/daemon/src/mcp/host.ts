import type { DaemonMessageInit } from '@kairos/contracts/device';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isAuthError, runMcpAuthFlow } from './auth.js';

const LIST_TOOLS_TIMEOUT_MS = 30_000;
const CALL_TOOL_TIMEOUT_MS = 120_000;
const MAX_RESULT_BYTES = 256 * 1024;

interface McpSession {
  client: Client;
}

type OpenValue = {
  sessionId: string;
  serverName: string;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
};

export class McpSessionHost {
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private readonly options: {
      send: (message: DaemonMessageInit) => Promise<void>;
      onError?: (error: unknown) => void;
    },
  ) {}

  async open(value: OpenValue): Promise<void> {
    if (this.sessions.has(value.sessionId)) {
      await this.sendOpenResult(value.sessionId, '', false);
      return;
    }
    try {
      await this.connect(value);
      await this.sendOpenResult(value.sessionId, '', false);
    } catch (error) {
      this.options.onError?.(error);
      await this.sendOpenResult(value.sessionId, errorMessage(error), isAuthError(error));
    }
  }

  private async connect(value: OpenValue): Promise<void> {
    const client = new Client({ name: 'kairos-daemon', version: '1.0.0' }, { capabilities: {} });
    let transport: Transport;
    if (value.transport === 'stdio') {
      if (value.command.length === 0) throw new Error('stdio MCP session requires a command.');
      transport = new StdioClientTransport({
        command: value.command,
        args: value.args,
        env: value.env,
        stderr: 'ignore',
      });
    } else if (value.transport === 'http') {
      transport = new StreamableHTTPClientTransport(new URL(value.url), {
        requestInit: { headers: value.headers },
      }) as unknown as Transport;
    } else if (value.transport === 'sse') {
      transport = new SSEClientTransport(new URL(value.url), {
        requestInit: { headers: value.headers },
      });
    } else {
      throw new Error(`Unsupported MCP transport "${value.transport}".`);
    }
    await client.connect(transport);
    this.sessions.set(value.sessionId, { client });
  }

  private async sendOpenResult(
    sessionId: string,
    error: string,
    needsAuth: boolean,
  ): Promise<void> {
    await this.options.send({
      payload: {
        case: 'mcpSessionOpenResult',
        value: { sessionId, error, needsAuth },
      },
    });
  }

  async beginAuth(value: {
    sessionId: string;
    requestId: string;
    serverName: string;
    transport: string;
    url: string;
    headers: Record<string, string>;
    redirectUri: string;
    accessToken?: string;
    refreshToken?: string;
  }): Promise<void> {
    if (this.authWaiters.has(value.requestId)) return;
    let notifyUrl: ((url: string) => void) | undefined;
    const urlSent = new Promise<void>((resolve) => {
      notifyUrl = (url: string) => {
        void this.options
          .send({
            payload: {
              case: 'mcpAuthUrl',
              value: {
                sessionId: value.sessionId,
                requestId: value.requestId,
                authorizationUrl: url,
                error: '',
              },
            },
          })
          .finally(resolve);
      };
    });
    const codePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.authWaiters.delete(value.requestId);
        reject(new Error('The OAuth authorization timed out.'));
      }, 15 * 60_000);
      this.authWaiters.set(value.requestId, { resolve, reject, timeout });
    });
    try {
      const result = await runMcpAuthFlow(
        {
          url: value.url,
          redirectUri: value.redirectUri,
          ...(value.accessToken === undefined ? {} : { accessToken: value.accessToken }),
          ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }),
        },
        {
          onAuthorizationUrl: (url) => notifyUrl?.(url),
          waitForCode: () => {
            void urlSent;
            return codePromise;
          },
        },
      );
      await this.options.send({
        payload: {
          case: 'mcpAuthResult',
          value: {
            sessionId: value.sessionId,
            requestId: value.requestId,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresInSeconds: BigInt(result.expiresInSeconds),
            error: '',
          },
        },
      });
    } catch (error) {
      await this.options.send({
        payload: {
          case: 'mcpAuthResult',
          value: {
            sessionId: value.sessionId,
            requestId: value.requestId,
            accessToken: '',
            refreshToken: '',
            expiresInSeconds: 0n,
            error: errorMessage(error),
          },
        },
      });
    } finally {
      this.authWaiters.delete(value.requestId);
    }
  }

  submitAuthCode(value: { sessionId: string; requestId: string; code: string }): void {
    const waiter = this.authWaiters.get(value.requestId);
    if (waiter === undefined) return;
    this.authWaiters.delete(value.requestId);
    clearTimeout(waiter.timeout);
    waiter.resolve(value.code);
  }

  private readonly authWaiters = new Map<
    string,
    { resolve: (code: string) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }
  >();

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    await session.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) await this.close(sessionId);
  }

  async listTools(value: { sessionId: string; requestId: string }): Promise<void> {
    const session = this.sessions.get(value.sessionId);
    if (session === undefined) {
      await this.sendList(value, [], 'The MCP session is not open.');
      return;
    }
    try {
      const result = await session.client.listTools(undefined, {
        timeout: LIST_TOOLS_TIMEOUT_MS,
      });
      await this.sendList(
        value,
        result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchemaJson: JSON.stringify(tool.inputSchema ?? { type: 'object' }),
        })),
        '',
      );
    } catch (error) {
      await this.sendList(value, [], errorMessage(error));
    }
  }

  async callTool(value: {
    sessionId: string;
    requestId: string;
    toolName: string;
    argumentsJson: string;
  }): Promise<void> {
    const session = this.sessions.get(value.sessionId);
    if (session === undefined) {
      await this.sendCall(value, '', true, 'The MCP session is not open.');
      return;
    }
    try {
      const args: unknown = value.argumentsJson.length === 0 ? {} : JSON.parse(value.argumentsJson);
      const result = await session.client.callTool(
        {
          name: value.toolName,
          arguments:
            typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
        },
        undefined,
        { timeout: CALL_TOOL_TIMEOUT_MS },
      );
      const contentJson = JSON.stringify(result.content ?? []);
      if (Buffer.byteLength(contentJson) > MAX_RESULT_BYTES) {
        await this.sendCall(
          value,
          '',
          true,
          `The MCP tool result exceeds ${String(MAX_RESULT_BYTES)} bytes.`,
        );
        return;
      }
      await this.sendCall(value, contentJson, result.isError === true, '');
    } catch (error) {
      await this.sendCall(value, '', true, errorMessage(error));
    }
  }

  private async sendList(
    value: { sessionId: string; requestId: string },
    tools: Array<{ name: string; description: string; inputSchemaJson: string }>,
    error: string,
  ): Promise<void> {
    await this.options.send({
      payload: {
        case: 'mcpListToolsResult',
        value: { sessionId: value.sessionId, requestId: value.requestId, tools, error },
      },
    });
  }

  private async sendCall(
    value: { sessionId: string; requestId: string },
    contentJson: string,
    isError: boolean,
    error: string,
  ): Promise<void> {
    await this.options.send({
      payload: {
        case: 'mcpCallToolResult',
        value: {
          sessionId: value.sessionId,
          requestId: value.requestId,
          contentJson,
          isError,
          error,
        },
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The MCP operation failed.';
}
