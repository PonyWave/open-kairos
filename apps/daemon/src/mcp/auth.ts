import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface McpAuthFlowInput {
  url: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface McpAuthFlowResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  authorizationUrl?: string;
}

class DaemonOAuthProvider implements OAuthClientProvider {
  private savedTokens: OAuthTokens | undefined;
  private clientInfo: OAuthClientInformationFull | undefined;
  private verifier = '';
  authorizationUrl = '';

  constructor(private readonly redirect: string) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirect],
      client_name: 'Kairos Daemon',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl.toString();
  }

  saveTokens(tokens: OAuthTokens): void {
    this.savedTokens = tokens;
  }

  tokens(): OAuthTokens | undefined {
    return this.savedTokens;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this.clientInfo = clientInformation;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.clientInfo;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

export interface McpAuthFlowHooks {
  onAuthorizationUrl: (url: string) => void;
  waitForCode: () => Promise<string>;
}

export async function runMcpAuthFlow(
  input: McpAuthFlowInput,
  hooks: McpAuthFlowHooks,
): Promise<McpAuthFlowResult> {
  const provider = new DaemonOAuthProvider(input.redirectUri);
  if (input.refreshToken !== undefined && input.refreshToken.length > 0) {
    provider.saveTokens({
      access_token: input.accessToken ?? '',
      refresh_token: input.refreshToken,
      token_type: 'Bearer',
    });
  }
  const first = await auth(provider, { serverUrl: input.url });
  if (first === 'REDIRECT') {
    hooks.onAuthorizationUrl(provider.authorizationUrl);
    const code = await hooks.waitForCode();
    await auth(provider, { serverUrl: input.url, authorizationCode: code });
  }
  const tokens = provider.tokens();
  if (tokens === undefined || tokens.access_token.length === 0) {
    throw new Error('The OAuth flow did not produce an access token.');
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresInSeconds: tokens.expires_in ?? 0,
    ...(provider.authorizationUrl.length > 0
      ? { authorizationUrl: provider.authorizationUrl }
      : {}),
  };
}

export function isAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? String(error.name) : '';
  if (name === 'UnauthorizedError') return true;
  const message = error instanceof Error ? error.message : '';
  return /\b401\b|unauthorized/i.test(message);
}
