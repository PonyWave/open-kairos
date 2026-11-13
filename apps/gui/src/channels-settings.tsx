import { ChannelId, ChannelLoginState, type ChannelState } from '@kairos/contracts';
import QRCode from 'qrcode';
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppDialog } from './app-dialog.js';
import feishuLogo from './assets/feishu-brand.png';
import wechatLogo from './assets/wechat-brand.svg';
import { ChannelSettingsController, type ChannelSettingsState } from './channel-settings-state.js';
import type { KairosClients } from './client.js';
import { Icon } from './icon.js';
import './channels.css';

export function ChannelSettings({
  clients,
  onDirtyChange,
}: {
  clients: KairosClients;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const controller = useMemo(() => new ChannelSettingsController(clients.channels), [clients]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [formDirty, setFormDirty] = useState(false);
  const [confirm, setConfirm] = useState<ChannelState | null>(null);
  const busy = Object.keys(state.busy).length > 0;
  useEffect(() => {
    controller.start();
    const refresh = () => {
      if (document.visibilityState === 'visible') void controller.refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.stop();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [controller]);
  useEffect(() => {
    onDirtyChange(formDirty || busy);
    return () => onDirtyChange(false);
  }, [formDirty, busy, onDirtyChange]);
  return (
    <div className="channel-settings">
      <div className="channel-page-heading">
        <h2>聊天渠道</h2>
        <p>连接微信或飞书，在聊天软件中继续与主对话交流。</p>
      </div>
      {state.loadError && (
        <div className="channel-error" role="alert">
          <p>{state.loadError}</p>
          <button
            type="button"
            className="device-secondary"
            disabled={state.loading}
            onClick={() => void controller.refresh()}
          >
            重新获取状态
          </button>
        </div>
      )}
      {state.states === null ? (
        <div className="channel-empty-state" role="status">
          {state.loading ? '正在获取连接状态…' : '暂时无法确认连接状态，请重新获取。'}
        </div>
      ) : (
        <>
          <WechatCard state={state} controller={controller} onUnbind={setConfirm} />
          <FeishuCard
            state={state}
            controller={controller}
            onUnbind={setConfirm}
            onDirtyChange={setFormDirty}
          />
        </>
      )}
      {confirm && (
        <AppDialog
          title={confirm.boundExternalUserId ? '解除渠道绑定' : '移除渠道配置'}
          onClose={() => setConfirm(null)}
          closeDisabled={Boolean(state.busy[confirm.channel])}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                disabled={Boolean(state.busy[confirm.channel])}
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="device-primary device-danger"
                disabled={Boolean(state.busy[confirm.channel])}
                onClick={() =>
                  void controller.unbind(confirm.channel).then((saved) => {
                    if (saved) setConfirm(null);
                  })
                }
              >
                {state.busy[confirm.channel]
                  ? '正在移除…'
                  : confirm.boundExternalUserId
                    ? '解除绑定'
                    : '移除配置'}
              </button>
            </>
          }
        >
          <p>
            将移除{confirm.channel === ChannelId.WECHAT ? '微信' : '飞书'}
            的凭据和绑定。此渠道将停止接收和发送消息；Kairos
            中已有的对话保留。再次使用时需要重新配对。
          </p>
          {state.errors[confirm.channel] && (
            <p className="channel-error" role="alert">
              {state.errors[confirm.channel]}
            </p>
          )}
        </AppDialog>
      )}
    </div>
  );
}
function getState(state: ChannelSettingsState, id: ChannelId): ChannelState | undefined {
  return state.states?.find((s) => s.channel === id);
}
function Card({
  name,
  channel,
  status,
  tone,
  children,
}: {
  name: string;
  channel: 'wechat' | 'feishu';
  status: string;
  tone?: 'waiting' | 'success' | 'error' | undefined;
  children: ReactNode;
}) {
  return (
    <section className={`channel-card channel-card-${channel}`} aria-label={`${name}连接`}>
      <header className="channel-heading">
        <div className="channel-name">
          <span className={`channel-brand channel-brand-${channel}`}>
            <img src={channel === 'wechat' ? wechatLogo : feishuLogo} alt="" />
          </span>
          <h3>{name}</h3>
        </div>
        <span className={`channel-status ${tone ?? ''}`} role="status">
          {status}
        </span>
      </header>
      {children}
    </section>
  );
}
function Notice({
  error,
  feedback,
}: {
  error?: string | undefined;
  feedback?: string | undefined;
}) {
  const readable = error?.startsWith('飞书长连接')
    ? '暂时无法连接飞书，请检查应用配置和网络后重试。'
    : error;
  return (
    <>
      {error && (
        <div className="channel-error" role="alert">
          <p>{readable}</p>
          {readable !== error && (
            <details className="channel-error-detail">
              <summary>技术详情</summary>
              <p>{error}</p>
            </details>
          )}
        </div>
      )}
      {feedback && (
        <p className="channel-feedback" role="status">
          {feedback}
        </p>
      )}
    </>
  );
}
function Account({ state }: { state: ChannelState }) {
  return (
    <div className="channel-account">
      <div>
        <span>应用</span>
        <code title={state.accountLabel}>{state.accountLabel || '已保存配置'}</code>
      </div>
      {state.boundExternalUserId && (
        <details>
          <summary>
            已配对账号 ·{' '}
            {state.boundExternalUserId.length > 16
              ? `${state.boundExternalUserId.slice(0, 7)}…${state.boundExternalUserId.slice(-4)}`
              : state.boundExternalUserId}
          </summary>
          <code>{state.boundExternalUserId}</code>
        </details>
      )}
    </div>
  );
}

function WechatCard({
  state,
  controller,
  onUnbind,
}: {
  state: ChannelSettingsState;
  controller: ChannelSettingsController;
  onUnbind: (state: ChannelState) => void;
}) {
  const channel = getState(state, ChannelId.WECHAT),
    login = state.login,
    busy = state.busy[ChannelId.WECHAT];
  const [qr, setQr] = useState<{ content: string; image: string } | null>(null),
    [qrError, setQrError] = useState<string | null>(null),
    [pin, setPin] = useState(''),
    [pinSent, setPinSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pending = login?.loginState === ChannelLoginState.PENDING;
  const connected = channel?.loginState === ChannelLoginState.ACTIVE;
  const failed =
    login?.loginState === ChannelLoginState.ERROR ||
    channel?.loginState === ChannelLoginState.ERROR;
  const qrContent = pending ? login.qrContent : '';
  useEffect(() => {
    let live = true;
    setQr(null);
    setQrError(null);
    setPin('');
    setPinSent(false);
    if (qrContent)
      void QRCode.toDataURL(qrContent, { width: 232, margin: 3 })
        .then((image) => {
          if (live) setQr({ content: qrContent, image });
        })
        .catch(() => {
          if (live) setQrError('二维码无法显示，请重新生成。');
        });
    return () => {
      live = false;
    };
  }, [qrContent]);
  useEffect(() => {
    if (login?.awaitingPin) input.current?.focus();
  }, [login?.awaitingPin]);
  const error =
    state.errors[ChannelId.WECHAT] ??
    qrError ??
    (failed || login?.pollingFailed ? login?.statusReason || channel?.statusReason : undefined);
  const title =
    busy === 'start'
      ? '正在获取二维码'
      : pending
        ? login.pollingFailed
          ? '查询中断'
          : login.awaitingPin
            ? '等待验证码'
            : pinSent
              ? '等待确认'
              : '等待扫码'
        : connected
          ? '已连接'
          : failed
            ? '连接异常'
            : '未连接';
  return (
    <Card
      name="微信"
      channel="wechat"
      status={title}
      tone={pending ? 'waiting' : connected ? 'success' : failed ? 'error' : undefined}
    >
      <p className="channel-description">通过微信与主对话交流，当前支持私聊文字消息。</p>
      <Notice error={error ?? undefined} feedback={state.feedback[ChannelId.WECHAT]} />
      {pending ? (
        <>
          {login.awaitingPin || pinSent ? (
            <form
              className="channel-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!/^\d{1,12}$/.test(pin.trim())) return;
                setPinSent(true);
                void controller.submitPin(pin.trim()).then((saved) => {
                  if (saved) setPin('');
                  else setPinSent(false);
                });
              }}
            >
              {login.statusReason && !error && (
                <p className="channel-step-hint" role="status">
                  {login.statusReason}
                </p>
              )}
              <label htmlFor="wechat-pin">数字验证码</label>
              <input
                ref={input}
                id="wechat-pin"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                placeholder="输入微信显示的数字"
                disabled={Boolean(busy) || !login.awaitingPin}
              />
              <div className="channel-actions">
                <button
                  className="device-primary"
                  type="submit"
                  disabled={Boolean(busy) || !login.awaitingPin || !/^\d{1,12}$/.test(pin.trim())}
                >
                  {busy === 'pin' || !login.awaitingPin ? '等待微信确认…' : '提交验证码'}
                </button>
                <button
                  type="button"
                  className="channel-text-button"
                  disabled={Boolean(busy)}
                  onClick={() => void controller.startWechat()}
                >
                  重新扫码
                </button>
                <button
                  type="button"
                  className="channel-text-button"
                  disabled={Boolean(busy)}
                  onClick={() => void controller.cancelLogin()}
                >
                  取消连接
                </button>
              </div>
            </form>
          ) : (
            <div className="channel-qr-step">
              {qr?.content === qrContent && busy !== 'start' ? (
                <img
                  className="channel-qr-image"
                  src={qr.image}
                  width={232}
                  height={232}
                  alt="微信登录二维码"
                />
              ) : (
                <p role="status" className="channel-qr-placeholder">
                  正在生成二维码…
                </p>
              )}
              <p>请用微信扫描二维码并确认授权。</p>
              {login.statusReason && !error && (
                <p className="channel-step-hint" role="status">
                  {login.statusReason}
                </p>
              )}
              <div className="channel-actions">
                <button
                  type="button"
                  className="device-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void controller.startWechat()}
                >
                  重新生成二维码
                </button>
                <button
                  type="button"
                  className="channel-text-button"
                  disabled={Boolean(busy)}
                  onClick={() => void controller.cancelLogin()}
                >
                  取消连接
                </button>
              </div>
              <details className="channel-help">
                <summary>正在使用手机？</summary>
                <p>
                  请在另一台设备打开此页面，再使用手机微信扫码。二维码更新后，请使用页面上的最新二维码。
                </p>
              </details>
            </div>
          )}
          {(login.pollingFailed || state.errors[ChannelId.WECHAT]) && (
            <button
              className="device-secondary"
              type="button"
              disabled={state.loading}
              onClick={() => void controller.refresh(ChannelId.WECHAT)}
            >
              重试查询
            </button>
          )}
        </>
      ) : connected && channel ? (
        <>
          <Account state={channel} />
          <div className="channel-actions">
            <button
              className="device-secondary"
              type="button"
              disabled={state.loading || Boolean(busy)}
              onClick={() => void controller.refresh(ChannelId.WECHAT)}
            >
              {state.loading ? '正在查询…' : '检查状态'}
            </button>
            <button
              className="channel-text-button channel-danger"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => onUnbind(channel)}
            >
              解除绑定
            </button>
          </div>
        </>
      ) : (
        <>
          {channel?.loginState === ChannelLoginState.PENDING && (
            <p className="channel-step-hint">上次配对未完成，请重新生成二维码。</p>
          )}
          <div className="channel-actions">
            <button
              type="button"
              className="device-primary"
              disabled={Boolean(busy)}
              onClick={() => void controller.startWechat()}
            >
              {busy === 'start' ? '正在获取二维码…' : failed ? '重新连接微信' : '连接微信'}
            </button>
            {channel?.configured && (
              <button
                className="channel-text-button channel-danger"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => onUnbind(channel)}
              >
                解除绑定
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function FeishuCard({
  state,
  controller,
  onUnbind,
  onDirtyChange,
}: {
  state: ChannelSettingsState;
  controller: ChannelSettingsController;
  onUnbind: (state: ChannelState) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const channel = getState(state, ChannelId.FEISHU),
    busy = state.busy[ChannelId.FEISHU];
  const [editing, setEditing] = useState(false),
    [appId, setAppId] = useState(''),
    [secret, setSecret] = useState(''),
    [showSecret, setShowSecret] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [copiedCode, setCopiedCode] = useState<string | null>(null),
    [copyError, setCopyError] = useState<string | null>(null),
    [discard, setDiscard] = useState(false);
  const appInput = useRef<HTMLInputElement>(null),
    secretInput = useRef<HTMLInputElement>(null),
    original = useRef('');
  const configured = channel?.configured ?? false;
  const formOpen = !configured || editing;
  const dirty = formOpen && (appId !== original.current || secret !== '');
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const failed = channel?.loginState === ChannelLoginState.ERROR,
    paired = channel?.loginState === ChannelLoginState.ACTIVE;
  const beginEdit = () => {
    setAppId(channel?.accountLabel ?? '');
    original.current = channel?.accountLabel ?? '';
    setSecret('');
    setErrors({});
    setEditing(true);
    requestAnimationFrame(() => appInput.current?.focus());
  };
  const closeEdit = () => {
    setEditing(false);
    setSecret('');
    setAppId('');
    original.current = '';
    setDiscard(false);
  };
  async function save() {
    const next: Record<string, string> = {};
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId.trim()))
      next.id = '请从飞书应用的凭证页面复制完整 App ID（cli_ 开头）。';
    const keep = configured && appId.trim() === channel?.accountLabel && !secret.trim();
    if (!secret.trim() && !keep) next.secret = '请填写 App Secret。';
    setErrors(next);
    if (next.id) {
      appInput.current?.focus();
      return;
    }
    if (next.secret) {
      secretInput.current?.focus();
      return;
    }
    if (await controller.saveFeishu(appId.trim(), secret.trim(), keep)) closeEdit();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(channel?.pairingCode ?? '');
      setCopiedCode(channel?.pairingCode ?? null);
      setCopyError(null);
    } catch {
      setCopyError('无法自动复制，请选中配对码复制。');
    }
  }
  return (
    <Card
      name="飞书"
      channel="feishu"
      status={
        busy === 'save'
          ? '正在保存'
          : busy === 'reconnect'
            ? '正在连接'
            : failed
              ? '连接异常'
              : paired
                ? '已连接'
                : configured
                  ? channel?.boundExternalUserId
                    ? '正在连接'
                    : '等待配对'
                  : '未连接'
      }
      tone={failed ? 'error' : paired ? 'success' : configured ? 'waiting' : undefined}
    >
      <p className="channel-description">通过企业自建应用机器人与主对话交流。</p>
      <Notice
        error={state.errors[ChannelId.FEISHU] ?? (failed ? channel?.statusReason : undefined)}
        feedback={state.feedback[ChannelId.FEISHU]}
      />
      {formOpen ? (
        <form
          className="channel-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <details className="channel-help">
            <summary>准备飞书应用</summary>
            <ol>
              <li>
                在
                <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
                  飞书开放平台
                  <Icon name="external" className="i-xs" />
                </a>
                创建企业自建应用并启用机器人。
              </li>
              <li>
                事件订阅选择长连接，添加「接收消息」（im.message.receive_v1），配置接收和发送消息的权限，并发布应用。
              </li>
              <li>复制应用的 App ID 与 App Secret。保存后，将配对码发送给机器人。</li>
            </ol>
          </details>
          <label htmlFor="feishu-app-id">App ID</label>
          <input
            ref={appInput}
            id="feishu-app-id"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={200}
            value={appId}
            disabled={Boolean(busy)}
            aria-invalid={Boolean(errors.id)}
            aria-describedby={errors.id ? 'feishu-id-error' : undefined}
            onChange={(e) => {
              setAppId(e.target.value);
              setErrors((v) => ({ ...v, id: '' }));
            }}
            placeholder="cli_…"
          />
          {errors.id && (
            <p id="feishu-id-error" className="channel-field-error" role="alert">
              {errors.id}
            </p>
          )}
          <label htmlFor="feishu-app-secret">App Secret</label>
          <div className="channel-secret">
            <input
              ref={secretInput}
              id="feishu-app-secret"
              type={showSecret ? 'text' : 'password'}
              maxLength={200}
              value={secret}
              disabled={Boolean(busy)}
              aria-invalid={Boolean(errors.secret)}
              aria-describedby="feishu-secret-help"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setSecret(e.target.value);
                setErrors((v) => ({ ...v, secret: '' }));
              }}
              placeholder={
                configured && appId === channel?.accountLabel
                  ? '已保存，留空保留原密钥'
                  : '填写应用密钥'
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
              aria-pressed={showSecret}
              onClick={() => setShowSecret(!showSecret)}
            >
              <Icon name={showSecret ? 'eyeOff' : 'eye'} />
            </button>
          </div>
          <p className="channel-field-help" id="feishu-secret-help">
            密钥保存后不回显。{configured ? '修改配置后需要重新配对。' : ''}
          </p>
          {errors.secret && (
            <p className="channel-field-error" role="alert">
              {errors.secret}
            </p>
          )}
          <div className="channel-actions">
            <button
              type="submit"
              className="device-primary"
              disabled={Boolean(busy) || (editing && !dirty)}
            >
              {busy === 'save' ? '正在保存…' : '保存并继续'}
            </button>
            {state.errors[ChannelId.FEISHU] && (
              <button
                type="button"
                className="device-secondary"
                disabled={Boolean(busy) || state.loading}
                onClick={() => void controller.refresh(ChannelId.FEISHU)}
              >
                检查状态
              </button>
            )}
            {editing && (
              <button
                type="button"
                className="device-secondary"
                disabled={Boolean(busy)}
                onClick={() => (dirty ? setDiscard(true) : closeEdit())}
              >
                取消修改
              </button>
            )}
          </div>
        </form>
      ) : (
        <>
          {channel && <Account state={channel} />}
          {channel?.pairingCode && !paired && !failed && (
            <div className="channel-pairing-step">
              <h4>将配对码发送给机器人</h4>
              <div className="channel-pairing-value">
                <code>{channel.pairingCode}</code>
                <button type="button" className="device-secondary" onClick={() => void copy()}>
                  {copiedCode === channel.pairingCode ? '已复制' : '复制配对码'}
                </button>
              </div>
              <p role="status">等待收到配对码，完成后会自动更新状态。</p>
              <button
                type="button"
                className="channel-text-button"
                disabled={Boolean(busy)}
                onClick={() => void controller.saveFeishu(channel.accountLabel, '', true)}
              >
                重新生成配对码
              </button>
              {copyError && (
                <p className="channel-field-error" role="alert">
                  {copyError}
                </p>
              )}
            </div>
          )}
          <div className="channel-actions">
            {failed ? (
              <button
                type="button"
                className="device-primary"
                disabled={Boolean(busy)}
                onClick={() => void controller.reconnectFeishu()}
              >
                {busy === 'reconnect' ? '正在连接…' : '重新连接'}
              </button>
            ) : (
              <button
                type="button"
                className="device-secondary"
                disabled={Boolean(busy) || state.loading}
                onClick={() => void controller.refresh(ChannelId.FEISHU)}
              >
                {state.loading ? '正在查询…' : '检查状态'}
              </button>
            )}
            <button
              type="button"
              className="channel-text-button"
              disabled={Boolean(busy)}
              onClick={beginEdit}
            >
              修改凭据
            </button>
            {channel && (
              <button
                type="button"
                className="channel-text-button channel-danger"
                disabled={Boolean(busy)}
                onClick={() => onUnbind(channel)}
              >
                {channel.boundExternalUserId ? '解除绑定' : '移除配置'}
              </button>
            )}
          </div>
        </>
      )}
      {discard && (
        <AppDialog
          title="放弃凭据修改"
          onClose={() => setDiscard(false)}
          actions={
            <>
              <button type="button" className="device-secondary" onClick={() => setDiscard(false)}>
                继续编辑
              </button>
              <button type="button" className="device-primary" onClick={closeEdit}>
                放弃修改
              </button>
            </>
          }
        >
          <p>未保存的 App ID 与 App Secret 将被清除，已有连接保持不变。</p>
        </AppDialog>
      )}
    </Card>
  );
}
