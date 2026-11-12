import type { ConnectRouter } from '@connectrpc/connect';
import { SettingsService } from '@kairos/contracts';
import { AuthStore } from '../auth/store.js';
import { ProviderError } from '../providers/errors.js';
import { SessionError } from '../sessions/errors.js';
import type { SettingsStore } from '../settings/store.js';
import type { GuiAuthentication } from './auth.js';
import { identityResponse, requireGuiIdentity, requireOwner } from './auth.js';
import { asConnectError } from './errors.js';

export function registerSettingsRoutes(
  router: ConnectRouter,
  settings: SettingsStore,
  authentication: GuiAuthentication,
): void {
  const activeTests = new Set<string>();
  const handle = async <T>(effect: () => T | Promise<T>): Promise<T> => {
    try {
      return await effect();
    } catch (error) {
      throw asConnectError(error);
    }
  };
  router.service(SettingsService, {
    getSettings: (_request, context) =>
      handle(() => ({ settings: settings.get(requireOwner(context, authentication)) })),
    saveModelConnection: (request, context) =>
      handle(() => ({ settings: settings.save(requireOwner(context, authentication), request) })),
    deleteModelConnection: (request, context) =>
      handle(() => ({ settings: settings.delete(requireOwner(context, authentication), request) })),
    setDefaultModel: (request, context) =>
      handle(() => ({
        settings: settings.setDefault(requireOwner(context, authentication), request),
      })),
    testConfiguredModel: (request, context) =>
      handle(async () => {
        const ownerId = requireOwner(context, authentication);
        if (activeTests.has(ownerId) || activeTests.size >= 4)
          throw new SessionError('failed_precondition', '已有模型测试正在执行，请稍后重试。');
        activeTests.add(ownerId);
        try {
          return await settings.test(
            ownerId,
            request.modelId,
            request.expectedVersion,
            context.signal,
          );
        } catch (error) {
          if (error instanceof ProviderError) {
            const status = error.status;
            return {
              passed: false,
              message:
                status === 401 || status === 403
                  ? '模型服务拒绝鉴权，请核对 API key 和权限。'
                  : status === 404
                    ? '模型或 API 路径不存在，请核对模型 ID、基础 URL 和 API 类型。'
                    : status === 429
                      ? '模型服务已限流或额度不足，请稍后重试。'
                      : error.code === 'request_timeout'
                        ? '模型测试超时。'
                        : '模型请求失败，请核对服务状态、API 类型和模型能力。',
            };
          }
          throw error;
        } finally {
          activeTests.delete(ownerId);
        }
      }),
    updateProfile: (request, context) =>
      handle(() => {
        const identity = requireGuiIdentity(context, authentication);
        settings.updateProfile(identity.tenantId, identity.userId, request);
        const updated = new AuthStore(settings.database).getIdentityForUser(identity.userId);
        if (!updated) throw new SessionError('unauthenticated', '账号已失效。');
        return { identity: identityResponse(updated) };
      }),
    readAvatar: (request, context) =>
      handle(() =>
        settings.readAvatar(requireGuiIdentity(context, authentication).userId, request.avatarId),
      ),
  });
}
