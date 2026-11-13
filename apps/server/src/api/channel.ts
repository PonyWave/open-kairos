import { randomInt } from 'node:crypto';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import {
  ChannelDeliveryStatus,
  ChannelId,
  ChannelLoginState,
  ChannelService,
} from '@kairos/contracts';
import type { ChannelManager } from '../channels/manager.js';
import type { ChannelStateRecord } from '../channels/store.js';
import { ChannelDeliveryError } from '../channels/store.js';
import type { WechatLoginSession } from '../channels/wechat/adapter.js';
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

function toLoginResponse(session: WechatLoginSession) {
  return {
    loginSessionId: session.id,
    qrContent: session.qrContent,
    loginState:
      session.status === 'confirmed'
        ? ChannelLoginState.ACTIVE
        : session.status === 'failed'
          ? ChannelLoginState.ERROR
          : ChannelLoginState.PENDING,
    statusReason: session.reason,
    awaitingPin: session.awaitingPin,
    pollingFailed: session.pollingFailed,
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
      handle(() => {
        const states = channels.store.listStates(owner(context)).map(toStateResponse);
        const session = channels.wechat.currentLogin(owner(context));
        return { states, ...(session ? { wechatLogin: toLoginResponse(session) } : {}) };
      }),
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
        requireText(request.clientActionId, '操作编号', 200);
        const login = await channels.wechat.startLogin(request.clientActionId, ownerId);
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
        const session = channels.wechat.pollLogin(request.loginSessionId, owner(context));
        return toLoginResponse(session);
      }),
    submitChannelLoginPin: (request, context) =>
      handle(() => {
        owner(context);
        try {
          const session = channels.wechat.submitLoginPin(
            request.loginSessionId,
            request.pin.trim(),
            owner(context),
          );
          return toLoginResponse(session);
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
        requireText(request.clientActionId, '操作编号', 200);
        const appId = requireText(request.appId.trim(), 'App ID', 200);
        if (!/^cli_[0-9a-fA-F]{16}$/.test(appId))
          throw new SessionError(
            'invalid_argument',
            'App ID 格式无效，请从飞书应用的凭证页面复制。',
          );
        const previous = channels.store.getCredentials(ownerId, 'feishu');
        const appSecret =
          request.preserveSecret &&
          !request.appSecret.trim() &&
          previous?.kind === 'feishu' &&
          previous.appId === appId
            ? previous.appSecret
            : requireText(request.appSecret.trim(), 'App Secret', 200);
        const pairingCode = String(randomInt(100_000, 1_000_000));
        channels.store.saveFeishuCredentials(
          ownerId,
          { kind: 'feishu', appId, appSecret },
          pairingCode,
        );
        channels.feishu.reconnect();
        return {
          clientActionId: request.clientActionId,
          state: toStateResponse(channels.store.getState(ownerId, 'feishu')),
        };
      }),
    cancelChannelLogin: (request, context) =>
      handle(() => {
        owner(context);
        requireText(request.loginSessionId, '登录会话', 200);
        channels.wechat.cancelLogin(request.loginSessionId, owner(context));
        return {};
      }),
    reconnectChannel: (request, context) =>
      handle(() => {
        const ownerId = owner(context);
        requireText(request.clientActionId, '操作编号', 200);
        if (toChannelId(request.channel) !== 'feishu')
          throw new SessionError('invalid_argument', '请重新扫码连接微信。');
        const state = channels.store.getState(ownerId, 'feishu');
        if (!state.hasCredentials)
          throw new SessionError('failed_precondition', '请先填写飞书应用凭据。');
        channels.feishu.reconnect();
        return { state: toStateResponse(channels.store.getState(ownerId, 'feishu')) };
      }),
    unbindChannel: (request, context) =>
      handle(() => {
        const ownerId = owner(context);
        const channel = toChannelId(request.channel);
        if (channel === 'wechat') channels.wechat.cancelLogin(undefined, ownerId);
        const state = channels.store.unbind(ownerId, channel);
        if (channel === 'wechat') channels.wechat.sync();
        else channels.feishu.sync();
        return { clientActionId: request.clientActionId, state: toStateResponse(state) };
      }),
    listChannelDeliveries: (request, context) =>
      handle(() => {
        const ownerId = owner(context);
        if (request.deliveryIds.length > 100) {
          throw new SessionError('invalid_argument', '单次最多查询 100 条投递记录。');
        }
        for (const deliveryId of request.deliveryIds) {
          requireText(deliveryId, 'deliveryId', 200);
        }
        return {
          deliveries: channels.store.listDeliveries(ownerId, request.deliveryIds).map((record) => ({
            deliveryId: record.deliveryId,
            channel: record.channel === 'wechat' ? ChannelId.WECHAT : ChannelId.FEISHU,
            status:
              record.status === 'pending'
                ? ChannelDeliveryStatus.PENDING
                : record.status === 'delivering'
                  ? ChannelDeliveryStatus.DELIVERING
                  : record.status === 'succeeded'
                    ? ChannelDeliveryStatus.SUCCEEDED
                    : ChannelDeliveryStatus.FAILED,
            errorMessage: record.status === 'failed' ? (record.lastErrorMessage ?? '') : '',
          })),
        };
      }),
  });
}
