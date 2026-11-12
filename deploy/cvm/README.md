# 腾讯云 CVM 单机部署

本文说明在 Ubuntu 24.04 x86_64 上部署一套 Kairos 生产环境的方法。部署包含 Server、静态 GUI、Caddy 和本机 Daemon，使用显式单机执行模式，不依赖 K3s 或 OpenSandbox。实例验收结果单独记录在 `work/cvm-production-acceptance.json`，本文中的命令不代表对应实例已经通过验收。

## 1. 固定组件与目录

- Node.js 和 Caddy 版本分别读取仓库 `.node-version` 与已验证的 Caddy 2.10.2。`install-runtime.sh` 从官方地址下载，并分别核对官方 SHA-256、SHA-512 清单。
- Server/GUI 与 Linux Daemon 必须从同一个干净提交构建。上传后核对归档 SHA-256，安装前再核对包内 `SHA256SUMS`。
- Server 只监听 `127.0.0.1:4317`。Caddy 对外监听 80/443，通过 ACME `shortlived` 配置为固定公网 IP `43.142.128.4` 申请有效期 160 小时的证书，并转发 `/api`、`/health` 和 `/devices/wss`。`tls force_automate` 明确使用公开 ACME，不使用内部 CA；`default_sni` 让不发送 SNI 的 IP 客户端取得对应证书，Caddy 自动续期。更换公网 IP 后必须同时修改 Caddyfile、`KAIROS_PUBLIC_ORIGIN` 和证书配置。
- 单机执行模式使用普通设备 `cvm-production` 和 `/workspace`。首次 GUI 配对只创建一次性凭据，设备通过连接、能力和目录检查后才可执行 Agent 工作。该配置与 `KAIROS_SANDBOX_CONFIG_FILE` 互斥。
- 固定设备取消配对或 active 解除绑定后，再次“添加设备”在同一 env 上恢复为新的真实配对流程，恢复 `/workspace` 并签发新的一次性凭据。旧凭据和旧实例失效，设备必须重新完成配对、连接、能力和目录检查。只有配置的固定 env 允许从 revoked 恢复，其他环境的 revoked 禁止重发规则不变；取消、撤销和历史绑定记录按现有审计机制保留。
- 当前模式把配置设备分配给首个创建主对话的租户，其他租户不能接管该设备。生产邀请名单应只包含实际使用这台 CVM 的账号。

```text
/opt/kairos/releases/<commit>/       不可变 Server/GUI release
/opt/kairos/current/                 当前 release 的相对链接目标
/opt/kairos/runtime/                 固定 Node.js 与 Caddy
/opt/kairos/daemon-releases/         GUI 下载用的 Daemon 归档和清单
/opt/kairos-daemon/releases/<id>/    不可变 Daemon release
/etc/kairos/server.env               root 0600 的 Server 配置
/etc/kairos/caddy/Caddyfile          HTTPS 与反向代理
/etc/kairos-daemon/config.env        本机 loopback WS 与身份路径
/var/lib/kairos/server/              Server SQLite 与运行数据，0700
/var/lib/kairos/caddy/               Caddy 证书与状态，0700
/var/lib/kairos-daemon/identity.json Daemon 配对身份，0600
/workspace/                          本机 Agent 工作区，kairos 0750
```

`kairos-server`、`kairos-caddy` 和 `kairos` 是无登录 shell 的独立系统账号。Server 与 Daemon 在凭据未配置、设备未配对时保持停止，Caddy 可以先提供静态 GUI 和 HTTPS。

## 2. 构建与上传

在干净工作区执行：

```sh
pnpm check
COMMIT=$(git rev-parse HEAD)
node scripts/build-server-release.mjs
node deploy/server-release-smoke.mjs "dist/server-releases/$COMMIT"
node scripts/build-daemon-release.mjs --version "$COMMIT" --platform linux --arch x64 \
  --output "dist/daemon-releases/$COMMIT"
node apps/daemon/scripts/release-smoke.mjs \
  "dist/daemon-releases/$COMMIT/kairos-daemon-$COMMIT-ubuntu22.04-24.04-x86_64.tar.gz"
```

macOS 构建机必须禁止 AppleDouble 和扩展元数据进入归档。打包后拒绝绝对路径、路径穿越、`._*` 和 `__MACOSX`，并记录归档 SHA-256：

```sh
SERVER_ARCHIVE=dist/server-releases/kairos-server-$COMMIT.tar.gz
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$SERVER_ARCHIVE" \
  -C "dist/server-releases/$COMMIT" .
if tar -tzf "$SERVER_ARCHIVE" | awk '/^\// || /(^|\/)\.\.(\/|$)/ || /(^|\/)\._/ || /(^|\/)__MACOSX(\/|$)/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  printf 'Unsafe or platform-specific Server archive.\n' >&2
  exit 1
fi
shasum -a 256 "$SERVER_ARCHIVE"
```

通过腾讯云自动化助手 TAT 上传以下文件到 `/root/kairos-incoming/`：

- `install-runtime.sh` 和 `server-release-smoke.mjs`。
- Server release 归档。
- Linux Daemon 归档和对应的 `release-linux-x64.json`。

不得使用 `--allow-dirty` 构建正式发布包。上传目录仅 root 可访问：

```sh
install -d -m 0700 /root/kairos-incoming
bash /root/kairos-incoming/install-runtime.sh
```

## 3. 安装程序与服务

以下命令在 TAT 中以 root 执行。先替换提交和摘要，再核对归档、解包和安装。`install.sh` 会生成独立随机 `KAIROS_AUTH_SECRET`，但不会填写邀请邮箱、SMTP、模型或配对凭据。

```sh
COMMIT=<完整提交>
SERVER_ARCHIVE=/root/kairos-incoming/kairos-server-$COMMIT.tar.gz
DAEMON_ARCHIVE=/root/kairos-incoming/kairos-daemon-$COMMIT-ubuntu22.04-24.04-x86_64.tar.gz
SERVER_SHA256=<Server 归档 SHA-256>
DAEMON_SHA256=<Daemon 归档 SHA-256>

[[ $(sha256sum "$SERVER_ARCHIVE" | awk '{print $1}') == "$SERVER_SHA256" ]]
[[ $(sha256sum "$DAEMON_ARCHIVE" | awk '{print $1}') == "$DAEMON_SHA256" ]]
install -d -m 0755 /opt/kairos/incoming
if tar -tzf "$SERVER_ARCHIVE" | awk '/^\// || /(^|\/)\.\.(\/|$)/ || /(^|\/)\._/ || /(^|\/)__MACOSX(\/|$)/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  printf 'Unsafe or platform-specific Server archive.\n' >&2
  exit 1
fi
mkdir "/opt/kairos/incoming/$COMMIT"
tar -xzf "$SERVER_ARCHIVE" -C "/opt/kairos/incoming/$COMMIT"
(cd "/opt/kairos/incoming/$COMMIT" && sha256sum --quiet -c SHA256SUMS)
DAEMON_ARCHIVE="$DAEMON_ARCHIVE" DAEMON_SHA256="$DAEMON_SHA256" \
  bash "/opt/kairos/incoming/$COMMIT/cvm/install.sh"
/opt/kairos/runtime/node-v26.4.0-linux-x64/bin/node \
  /root/kairos-incoming/server-release-smoke.mjs "/opt/kairos/incoming/$COMMIT"
install -d -m 0755 /opt/kairos/releases
mv "/opt/kairos/incoming/$COMMIT" "/opt/kairos/releases/$COMMIT"
chown -R root:root "/opt/kairos/releases/$COMMIT"
ln -sfn "/opt/kairos/releases/$COMMIT" /opt/kairos/current.new
mv -Tf /opt/kairos/current.new /opt/kairos/current
systemctl restart kairos-caddy.service
```

`install.sh` 已执行 `systemd-analyze verify` 和 Caddy 配置解析。release smoke 使用独立临时数据库和 loopback 端口，不使用生产数据或真实凭据。Caddy 的证书和公网 GUI 另行验证，不以 smoke 代替。

安全组收敛前，保存原入站和出站规则、实例与安全组绑定关系及回退步骤。先确认 Caddy 配置、本机 80/443 监听和 HTTPS 证书，再把入站限制为 IPv4 80/443。TAT 不需要公网 SSH 入站；不要开放 4317 或 Daemon 监听端口。出站只保留系统、TAT、DNS、NTP、ACME、SMTP、模型和软件更新实际需要的连接。

## 4. 配置认证并启动 Server

编辑 `/etc/kairos/server.env`，安全设置以下项目，不要把真实凭据写入仓库、TAT 命令正文或验收记录：

- `KAIROS_AUTH_INVITED_EMAILS`：仅实际用户的邮箱。不要使用 `*` 代替邀请配置。
- `KAIROS_SMTP_URL`：独立 SMTP 或 SMTPS 账号连接地址。
- `KAIROS_SMTP_FROM`：验证码发件地址。
- 模型可在首次登录后的设置页配置，也可配置 `KAIROS_MODEL_*` 后重启 Server。

生产模式缺少邀请邮箱或 SMTP 时会拒绝启动。配置完成后执行：

```sh
chown root:root /etc/kairos/server.env
chmod 0600 /etc/kairos/server.env
systemctl enable --now kairos-server.service
curl --fail --silent --show-error http://127.0.0.1:4317/health
curl --fail --silent --show-error https://43.142.128.4/health
curl --fail --silent --show-error https://43.142.128.4/api/health
systemctl restart kairos-server.service kairos-caddy.service
systemctl is-active kairos-server.service kairos-caddy.service
```

使用真实浏览器核对有效证书、GUI、邮箱验证码登录、匿名身份接口和受保护 RPC 的拒绝行为。服务启动不代表登录、模型或主对话已验收。

## 5. 配对本机 Daemon

首次登录后在“连接设备”中选择“添加设备”。单机模式会使用 `cvm-production` 和 `/workspace`，安装命令中的公开 WSS 可用于其他设备；本机 Daemon 使用已有的 loopback WS 配置。

将一次性配对凭据通过 TAT 文件上传放到 `/root/kairos-incoming/pairing-credential`，不要粘贴到 TAT 命令正文。随后执行：

```sh
CREDENTIAL=/root/kairos-incoming/pairing-credential
trap 'rm -f "$CREDENTIAL"' EXIT
chmod 0600 "$CREDENTIAL"
runuser -u kairos -- /opt/kairos-daemon/current/bin/kairos-daemon pair-once \
  --identity-path /var/lib/kairos-daemon/identity.json \
  --env-id cvm-production \
  --server-url ws://127.0.0.1:4317/devices/wss \
  --directory /workspace \
  --device-name tencent-cvm <"$CREDENTIAL"
systemctl enable --now kairos-daemon.service
systemctl is-active kairos-daemon.service
stat -c '%a %U %G' /var/lib/kairos-daemon/identity.json
```

`pair-once` 只有返回“pairing and persisted readiness confirmed”才表示配对和目录就绪。退出码 69 表示已绑定但执行条件尚未就绪，必须查看输出并继续核对，不能标记 ready。身份文件应为 `kairos` 所有的 0600。配对凭据文件由 `trap` 删除。

完成真实模型配置后，在主对话发送一条可核对的消息，并检查实际回复、Daemon ready 和 `/workspace` 的 Operation。不得以数据库写入代替这些步骤。

## 6. 检查与恢复

```sh
systemctl status kairos-server.service kairos-caddy.service kairos-daemon.service --no-pager
ss -ltnp
df -h /
free -m
journalctl -u kairos-server.service -u kairos-caddy.service -u kairos-daemon.service -n 100 --no-pager
```

重启 Server 后，旧活动 Run 按现有恢复规则标记中断，不假定模型流透明续接。Caddy 重启保留证书状态。Daemon 重启复用身份并生成新实例编号，Server 重新核对 ready。验收需分别记录 systemd 状态、重启恢复、资源占用、HTTPS 证书链、GUI/API/WSS、空数据初始化和实际认证边界。
