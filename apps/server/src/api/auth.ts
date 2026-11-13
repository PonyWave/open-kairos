import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AuthenticationState,
  AuthService as AuthServiceDescriptor,
  ContractValidationError,
} from '@kairos/contracts';
import { AuthError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import type { Identity } from '../auth/types.js';
import { SessionError } from '../sessions/errors.js';

const sessionCookie = 'kairos_session';
const csrfCookie = 'kairos_csrf';
const csrfHeader = 'x-csrf-token';

const readOnlyMethods = new Set([
  'getThread',
  'listThreads',
  'listThreadCards',
  'listThreadCallPreviews',
  'listSubagentCallViews',
  'downloadAttachment',
  'readContext',
  'readRecaps',
  'readBashLog',
  'getModelStatus',
  'getSettings',
  'readAvatar',
  'watchThread',
  'listEnvironments',
  'getEnvironment',
  'getEnvironmentDaemonCommands',
  'listEnvironmentDirectories',
]);

export interface GuiAuthentication {
  authService: AuthService;
  allowedOrigin: string | null;
  secureCookies: boolean;
  disabled?: boolean;
}

export function requireOwner(context: HandlerContext, authentication: GuiAuthentication): string {
  try {
    if (!readOnlyMethods.has(context.method.localName)) {
      requireStateRequest(context, authentication);
    }
    return resolveIdentity(context, authentication).tenantId;
  } catch (error) {
    if (error instanceof AuthError && error.code === 'permission_denied') {
      throw new SessionError('permission_denied', error.message, { cause: error });
    }
    if (error instanceof AuthError) {
      throw new SessionError('unauthenticated', error.message, { cause: error });
    }
    throw error;
  }
}

export function requireGuiIdentity(
  context: HandlerContext,
  authentication: GuiAuthentication,
): Identity {
  requireOwner(context, authentication);
  return resolveIdentity(context, authentication);
}

function resolveIdentity(context: HandlerContext, authentication: GuiAuthentication): Identity {
  if (authentication.disabled) return authentication.authService.ensureLocalIdentity();
  return authentication.authService.requireIdentity(cookieValue(context, sessionCookie));
}

export function registerAuthRoutes(router: ConnectRouter, authentication: GuiAuthentication): void {
  const service = authentication.authService;
  router.service(AuthServiceDescriptor, {
    bootstrapSession: (request, context) => {
      try {
        requireStateRequest(context, authentication);
        if (authentication.disabled) {
          return { identity: identityResponse(service.ensureLocalIdentity()) };
        }
        if (request.token.trim().length === 0 || request.token.length > 200) {
          throw new AuthError('invalid_argument', 'The local session token is invalid.');
        }
        const bootstrapped = service.bootstrapSession(request.token);
        setCookie(
          context,
          sessionCookie,
          request.token,
          bootstrapped.expiresAt,
          authentication.secureCookies,
          true,
        );
        return { identity: identityResponse(bootstrapped.identity) };
      } catch (error) {
        throw authConnectError(error);
      }
    },
    getCurrentIdentity: (_request, context) => {
      ensureCsrfCookie(context, authentication.secureCookies);
      if (authentication.disabled) {
        return {
          state: AuthenticationState.AUTHENTICATED,
          identity: identityResponse(service.ensureLocalIdentity()),
        };
      }
      const current = service.currentIdentity(cookieValue(context, sessionCookie));
      return current.state === 'authenticated'
        ? {
            state: AuthenticationState.AUTHENTICATED,
            identity: identityResponse(current.identity),
          }
        : { state: AuthenticationState.ANONYMOUS };
    },
    logout: (_request, context) => {
      try {
        requireStateRequest(context, authentication);
        if (!authentication.disabled) {
          service.revokeSession(cookieValue(context, sessionCookie));
          clearCookie(context, sessionCookie, authentication.secureCookies);
        }
        return {};
      } catch (error) {
        throw authConnectError(error);
      }
    },
  });
}

export function requireStateRequest(
  context: HandlerContext,
  authentication: GuiAuthentication,
): void {
  const origin = context.requestHeader.get('origin') ?? '';
  const host = context.requestHeader.get('host') ?? '';
  if (!isAllowedOrigin(origin, authentication.allowedOrigin, host)) {
    throw new AuthError('permission_denied', 'The request Origin is not allowed.');
  }
  const expected = cookieValue(context, csrfCookie) ?? '';
  const supplied = context.requestHeader.get(csrfHeader) ?? '';
  if (!expected || !supplied || !safeEqual(expected, supplied)) {
    throw new AuthError('permission_denied', 'The CSRF token is missing or invalid.');
  }
}

function isAllowedOrigin(origin: string, allowedOrigin: string | null, host: string): boolean {
  if (allowedOrigin !== null) return origin === allowedOrigin;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return true;
    return host !== '' && url.host === host;
  } catch {
    return false;
  }
}

function ensureCsrfCookie(context: HandlerContext, secure: boolean): void {
  if (cookieValue(context, csrfCookie)) return;
  setCookie(
    context,
    csrfCookie,
    randomBytes(32).toString('base64url'),
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    secure,
    false,
  );
}

export function identityResponse(identity: Identity) {
  return {
    userId: identity.userId,
    email: identity.email,
    username: identity.username,
    tenantId: identity.tenantId,
    mainThreadId: identity.mainThreadId,
    ...(identity.avatarId ? { avatarId: identity.avatarId } : {}),
    profileVersion: identity.profileVersion ?? 0,
  };
}

function cookieValue(context: HandlerContext, name: string): string | undefined {
  const header = context.requestHeader.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function setCookie(
  context: HandlerContext,
  name: string,
  value: string,
  expiresAt: string,
  secure: boolean,
  httpOnly: boolean,
): void {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  context.responseHeader.append(
    'set-cookie',
    `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(
      expiresAt,
    ).toUTCString()}${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}`,
  );
}

function clearCookie(context: HandlerContext, name: string, secure: boolean): void {
  context.responseHeader.append(
    'set-cookie',
    `${name}=; Path=/; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly${secure ? '; Secure' : ''}`,
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof ContractValidationError) {
    return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
  }
  if (error instanceof AuthError) {
    const codes = {
      unauthenticated: Code.Unauthenticated,
      permission_denied: Code.PermissionDenied,
      invalid_argument: Code.InvalidArgument,
      not_found: Code.NotFound,
      conflict: Code.AlreadyExists,
      resource_exhausted: Code.ResourceExhausted,
      unavailable: Code.Unavailable,
      internal: Code.Internal,
    } as const;
    return new ConnectError(error.message, codes[error.code], undefined, undefined, error);
  }
  return new ConnectError(
    'Authentication operation failed.',
    Code.Internal,
    undefined,
    undefined,
    error,
  );
}
