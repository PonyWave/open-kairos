import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import {
  AttachmentService,
  AuthService,
  AutomationService,
  ContextService,
  EnvironmentService,
  EventService,
  MessageService,
  QueueService,
  RunService,
  SettingsService,
  ThreadService,
  WorkspaceService,
} from '@kairos/contracts';

export interface KairosClients {
  settings: ReturnType<typeof createClient<typeof SettingsService>>;
  environments: ReturnType<typeof createClient<typeof EnvironmentService>>;
  auth: ReturnType<typeof createClient<typeof AuthService>>;
  attachments: ReturnType<typeof createClient<typeof AttachmentService>>;
  automations: ReturnType<typeof createClient<typeof AutomationService>>;
  thread: ReturnType<typeof createClient<typeof ThreadService>>;
  messages: ReturnType<typeof createClient<typeof MessageService>>;
  queue: ReturnType<typeof createClient<typeof QueueService>>;
  runs: ReturnType<typeof createClient<typeof RunService>>;
  context: ReturnType<typeof createClient<typeof ContextService>>;
  events: ReturnType<typeof createClient<typeof EventService>>;
  workspace: ReturnType<typeof createClient<typeof WorkspaceService>>;
}

export interface KairosClientOptions {
  baseUrl?: string;
  getCsrfToken?: () => string;
  getAuthenticationGeneration?: () => number;
  onUnauthenticated?: (authenticationGeneration: number) => void;
  fetch?: typeof globalThis.fetch;
  transport?: Transport;
}

export function createKairosClients(options: KairosClientOptions = {}): KairosClients {
  const getCsrfToken = options.getCsrfToken ?? (() => readBrowserCookie('kairos_csrf'));
  const session: Interceptor = (next) => async (request) => {
    const authenticationGeneration = options.getAuthenticationGeneration?.() ?? 0;
    const csrfToken = getCsrfToken().trim();
    if (csrfToken) request.header.set('x-csrf-token', csrfToken);
    const report = (cause: unknown) => {
      if (
        request.service.typeName !== AuthService.typeName &&
        cause instanceof ConnectError &&
        cause.code === Code.Unauthenticated
      ) {
        options.onUnauthenticated?.(authenticationGeneration);
      }
    };
    try {
      const response = await next(request);
      if (!response.stream) return response;
      const messages = response.message;
      return {
        ...response,
        message: (async function* () {
          try {
            yield* messages;
          } catch (cause) {
            report(cause);
            throw cause;
          }
        })(),
      };
    } catch (cause) {
      report(cause);
      throw cause;
    }
  };
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const transport =
    options.transport ??
    createConnectTransport({
      baseUrl: options.baseUrl ?? '/api',
      useBinaryFormat: true,
      interceptors: [session],
      fetch: (input, init) => fetchImplementation(input, { ...init, credentials: 'include' }),
    });
  return {
    settings: createClient(SettingsService, transport),
    environments: createClient(EnvironmentService, transport),
    auth: createClient(AuthService, transport),
    attachments: createClient(AttachmentService, transport),
    automations: createClient(AutomationService, transport),
    thread: createClient(ThreadService, transport),
    messages: createClient(MessageService, transport),
    queue: createClient(QueueService, transport),
    runs: createClient(RunService, transport),
    context: createClient(ContextService, transport),
    events: createClient(EventService, transport),
    workspace: createClient(WorkspaceService, transport),
  };
}

export function readBrowserCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}
