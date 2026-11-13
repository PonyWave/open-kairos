import { randomInt } from 'node:crypto';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { ChannelId, ChannelLoginState, ChannelService } from '@kairos/contracts';
import type { ChannelManager } from '../channels/manager.js';
import type { ChannelStateRecord } from '../channels/store.js';
import { ChannelDeliveryError } from '../channels/store.js';
import { requireText, SessionError } from '../sessions/errors.js';
import type { GuiAuthentication } from './auth.js';
import { requireOwner } from './auth.js';
import { asConnectError } from './errors.js';

function toChannelId(value: ChannelId): 'wechat' | 'feishu' {
  if (value === ChannelId.WECHAT) return 'wechat';
  if (value === ChannelId.FEISHU) return 'feishu';
  throw new SessionError('invalid_argument', '不支持的渠道。');
}

function toLoginState(state: ChannelStateRecord): ChannelLoginState {
  switch (state.status) {
    case 'unconfigured':
      return ChannelLoginState.UNCONFIGURED;
    case 'pending_login':
    case 'pending_binding':
      return ChannelLoginState.PENDING;
    case 'active':
      return ChannelLoginState.ACTIVE;
    case 'error':
      return ChannelLoginState.ERROR;
  }
}

function toStateResponse(state: ChannelStateRecord) {
  return {
    channel: state.channel === 'wechat' ? ChannelId.WECHAT : ChannelId.FEISHU,
    loginState: toLoginState(state),
    configured: state.hasCredentials,
    accountLabel: state.accountLabel,
    boundExternalUserId: state.externalUserId ?? '',
    statusReason: state.statusReason,
    ...(state.status === 'pending_binding' && state.pairingCode !== null
      ? { pairingCode: state.pairingCode }
      : {}),
  };
}

export function registerChannelRoutes(
  router: ConnectRouter,
  channels: ChannelManager,
  authentication: GuiAuthentication,
): void {
  const owner = (context: HandlerContext) => requireOwner(context, authentication);
  const handle = async <T>(effect: () => T | Promise<T>): Promise<T> => {
    try {
      return await effect();
    } catch (error) {
      throw asConnectError(error);
    }
  };
  router.service(ChannelService, {
    getChannelStates: (_request, context) =>
      handle(() => ({
        states: channels.store.listStates(owner(context)).map(toStateResponse),
      })),
    startChannelLogin: (request, context) =>
      handle(async () => {
        const ownerId = owner(context);
        const channel = toChannelId(request.channel);
        if (channel !== 'wechat') {
          throw new SessionError(
            'invalid_argument',
            '飞书渠道通过保存应用凭证接入，不需要扫码登录。',
          );
        }
        const login = await channels.wechat.startLogin();
        return {
          clientActionId: request.clientActionId,
          state: toStateResponse(channels.store.getState(ownerId, 'wechat')),
          qrContent: login.qrContent,
          loginSessionId: login.sessionId,
        };
      }),
    pollChannelLogin: (request, context) =>
      handle(() => {
        owner(context);
        const session = channels.wechat.pollLogin(request.loginSessionId);
        return {
          loginState:
            session.status === 'confirmed'
              ? ChannelLoginState.ACTIVE
              : session.status === 'failed'
                ? ChannelLoginState.ERROR
                : ChannelLoginState.PENDING,
          statusReason: session.reason,
          awaitingPin: session.awaitingPin,
        };
      }),
    submitChannelLoginPin: (request, context) =>
      handle(() => {
        owner(context);
        try {
          const session = channels.wechat.submitLoginPin(
            request.loginSessionId,
            request.pin.trim(),
          );
          return {
            loginState:
              session.status === 'confirmed'
                ? ChannelLoginState.ACTIVE
                : session.status === 'failed'
                  ? ChannelLoginState.ERROR
                  : ChannelLoginState.PENDING,
            statusReason: session.reason,
            awaitingPin: session.awaitingPin,
          };
        } catch (error) {
          if (error instanceof ChannelDeliveryError) {
            throw new SessionError('invalid_argument', error.message);
          }
          throw error;
        }
      }),
    saveFeishuCredentials: (request, context) =>
      handle(() => {
        const ownerId = owner(context);
        const appId = requireText(request.appId.trim(), 'App ID', 200);
        const appSecret = requireText(request.appSecret.trim(), 'App Secret', 200);
        const pairingCode = String(randomInt(100_000, 1_000_000));
        channels.store.saveFeishuCredentials(
          ownerId,
          { kind: 'feishu', appId, appSecret },
          pairingCode,
        );
        channels.feishu.sync();
        return {
          clientActionId: request.clientActionId,
          state: toStateResponse(channels.store.getState(ownerId, 'feishu')),
        };
      }),
    unbindChannel: (request, context) =>
      handle(() => {
        const ownerId = owner(context);
        const channel = toChannelId(request.channel);
        const state = channels.store.unbind(ownerId, channel);
        if (channel === 'wechat') channels.wechat.sync();
        else channels.feishu.sync();
        return { clientActionId: request.clientActionId, state: toStateResponse(state) };
      }),
  });
}
