import {
  ChannelId,
  ChannelLoginState,
  type ChannelState,
  create,
  GetChannelStatesRequestSchema,
} from '@kairos/contracts';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';

function stateOf(states: ChannelState[], channel: ChannelId): ChannelState | undefined {
  return states.find((state) => state.channel === channel);
}

function statusText(state: ChannelState | undefined): string {
  switch (state?.loginState) {
    case ChannelLoginState.ACTIVE:
      return '已连接';
    case ChannelLoginState.PENDING:
      return '等待完成绑定';
    case ChannelLoginState.ERROR:
      return '连接异常';
    default:
      return '未配置';
  }
}

export function ChannelSettings({ clients }: { clients: KairosClients }) {
  const [states, setStates] = useState<ChannelState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await clients.channels.getChannelStates(
        create(GetChannelStatesRequestSchema, {}),
      );
      setStates(response.states);
      setError(null);
    } catch (cause) {
      setError(formatClientError(cause));
    }
  }, [clients]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const wechat = stateOf(states, ChannelId.WECHAT);
  const feishu = stateOf(states, ChannelId.FEISHU);

  return (
    <div className="settings-form">
      <div className="settings-section-heading">
        <h2>IM 渠道</h2>
        <p>
          连接微信和飞书后，可以直接在 IM 里和全局 main 对话；消息气泡会标注来源，回复通过
          send_to_user 的 channels 参数投递。
        </p>
      </div>
      {error ? <p className="settings-error">{error}</p> : null}
      <WechatSection
        clients={clients}
        state={wechat}
        busy={busy}
        setBusy={setBusy}
        reload={reload}
        onError={setError}
      />
      <FeishuSection
        clients={clients}
        state={feishu}
        busy={busy}
        setBusy={setBusy}
        reload={reload}
        onError={setError}
      />
    </div>
  );
}

function WechatSection({
  clients,
  state,
  busy,
  setBusy,
  reload,
  onError,
}: {
  clients: KairosClients;
  state: ChannelState | undefined;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  reload: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [qrImage, setQrImage] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startLogin = async () => {
    setBusy(true);
    onError(null);
    try {
      const response = await clients.channels.startChannelLogin({
        clientActionId: crypto.randomUUID(),
        channel: ChannelId.WECHAT,
      });
      setQrImage(await QRCode.toDataURL(response.qrContent, { width: 220 }));
      stopPolling();
      pollTimer.current = setInterval(() => {
        void clients.channels
          .pollChannelLogin({ loginSessionId: response.loginSessionId })
          .then(async (status) => {
            if (status.loginState === ChannelLoginState.ACTIVE) {
              stopPolling();
              setQrImage(null);
              await reload();
            } else if (status.loginState === ChannelLoginState.ERROR) {
              stopPolling();
              setQrImage(null);
              onError(status.statusReason || '微信登录失败，请重新生成二维码。');
              await reload();
            }
          })
          .catch(() => undefined);
      }, 2_000);
    } catch (cause) {
      onError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    setBusy(true);
    onError(null);
    try {
      stopPolling();
      setQrImage(null);
      await clients.channels.unbindChannel({
        clientActionId: crypto.randomUUID(),
        channel: ChannelId.WECHAT,
      });
      await reload();
    } catch (cause) {
      onError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-connection channel-section">
      <div className="settings-section-heading">
        <h3>微信</h3>
        <p>
          状态：{statusText(state)}
          {state?.loginState === ChannelLoginState.ACTIVE && state.boundExternalUserId
            ? `（已绑定 ${state.boundExternalUserId}）`
            : ''}
        </p>
        {state?.statusReason ? <p className="settings-help">{state.statusReason}</p> : null}
        <p className="settings-help">使用微信扫码绑定 ClawBot 通道；仅支持私聊，消息为纯文本。</p>
      </div>
      {qrImage ? (
        <div className="channel-qr">
          <img src={qrImage} alt="微信登录二维码" width={220} height={220} />
          <p className="settings-help">请用微信扫描二维码并确认授权。</p>
        </div>
      ) : null}
      <div className="button-row">
        {state?.loginState === ChannelLoginState.ACTIVE ? (
          <button type="button" disabled={busy} onClick={() => void unbind()}>
            解除绑定
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void startLogin()}>
            {qrImage ? '重新生成二维码' : '生成登录二维码'}
          </button>
        )}
      </div>
    </section>
  );
}

function FeishuSection({
  clients,
  state,
  busy,
  setBusy,
  reload,
  onError,
}: {
  clients: KairosClients;
  state: ChannelState | undefined;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  reload: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');

  const save = async () => {
    setBusy(true);
    onError(null);
    try {
      await clients.channels.saveFeishuCredentials({
        clientActionId: crypto.randomUUID(),
        appId: appId.trim(),
        appSecret: appSecret.trim(),
      });
      setAppId('');
      setAppSecret('');
      await reload();
    } catch (cause) {
      onError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    setBusy(true);
    onError(null);
    try {
      await clients.channels.unbindChannel({
        clientActionId: crypto.randomUUID(),
        channel: ChannelId.FEISHU,
      });
      await reload();
    } catch (cause) {
      onError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-connection channel-section">
      <div className="settings-section-heading">
        <h3>飞书</h3>
        <p>
          状态：{statusText(state)}
          {state?.loginState === ChannelLoginState.ACTIVE && state.boundExternalUserId
            ? `（已绑定 ${state.boundExternalUserId}）`
            : ''}
        </p>
        {state?.statusReason ? <p className="settings-help">{state.statusReason}</p> : null}
        <p className="settings-help">
          在飞书开放平台创建企业自建应用并添加机器人能力，事件订阅选择长连接并订阅「接收消息」
          （im.message.receive_v1），然后在这里保存 App ID 与 App Secret。
        </p>
      </div>
      {state?.loginState === ChannelLoginState.PENDING && state.pairingCode ? (
        <p className="channel-pairing-code">
          配对码：<strong>{state.pairingCode}</strong>
          （在飞书里把该配对码发送给机器人完成绑定）
        </p>
      ) : null}
      {state?.loginState === ChannelLoginState.ACTIVE ? (
        <div className="button-row">
          <button type="button" disabled={busy} onClick={() => void unbind()}>
            解除绑定
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            App ID
            <input
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="cli_..."
              autoComplete="off"
            />
          </label>
          <label>
            App Secret
            <input
              type="password"
              value={appSecret}
              onChange={(event) => setAppSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="button-row">
            <button type="submit" disabled={busy || !appId.trim() || !appSecret.trim()}>
              保存并生成配对码
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
