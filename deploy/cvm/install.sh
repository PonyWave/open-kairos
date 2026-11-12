#!/usr/bin/env bash
set -euo pipefail
set +x

[[ $EUID -eq 0 ]] || { printf 'error: run as root.\n' >&2; exit 1; }
SCRIPT_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELEASE_ROOT=$(cd "$SCRIPT_DIRECTORY/.." && pwd)
DAEMON_ARCHIVE=${DAEMON_ARCHIVE:?set DAEMON_ARCHIVE to the uploaded Linux archive}
DAEMON_SHA256=${DAEMON_SHA256:?set DAEMON_SHA256 to the expected archive hash}
DAEMON_MANIFEST=${DAEMON_MANIFEST:-$(dirname "$DAEMON_ARCHIVE")/release-linux-x64.json}
NODE=/opt/kairos/runtime/node-v26.4.0-linux-x64/bin/node
CADDY=/opt/kairos/runtime/caddy-2.10.2/caddy
[[ -x $NODE && -x $CADDY ]]
[[ -f $RELEASE_ROOT/release.json && -f $RELEASE_ROOT/gui/index.html ]]
[[ $DAEMON_SHA256 =~ ^[a-f0-9]{64}$ ]]
[[ $(sha256sum "$DAEMON_ARCHIVE" | awk '{print $1}') == "$DAEMON_SHA256" ]]
python3 -c 'import json,os,sys; manifest=json.load(open(sys.argv[1])); assert manifest["file"]==os.path.basename(sys.argv[2]); assert manifest["sha256"]==sys.argv[3]; assert manifest["platform"]=="linux" and manifest["architecture"]=="x64"' \
  "$DAEMON_MANIFEST" "$DAEMON_ARCHIVE" "$DAEMON_SHA256"

for user in kairos-server kairos-caddy; do
  if ! getent passwd "$user" >/dev/null; then
    home=/var/lib/kairos/${user#kairos-}
    useradd --system --user-group --home-dir "$home" --shell /usr/sbin/nologin "$user"
  fi
  [[ $(id -u "$user") -ne 0 ]]
done
if ! getent passwd kairos >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/kairos-daemon --shell /usr/sbin/nologin kairos
fi
[[ $(id -u kairos) -ne 0 ]]

install -d -m 0755 -o root -g root /opt/kairos /opt/kairos/releases /etc/kairos /var/lib/kairos
install -d -m 0700 -o kairos-server -g kairos-server /var/lib/kairos/server
install -d -m 0700 -o kairos-caddy -g kairos-caddy /var/lib/kairos/caddy \
  /var/lib/kairos/caddy/data /var/lib/kairos/caddy/config
install -d -m 0750 -o root -g kairos-server /opt/kairos/daemon-releases
install -d -m 0755 -o root -g root /etc/kairos/caddy
install -m 0644 -o root -g root "$SCRIPT_DIRECTORY/Caddyfile" /etc/kairos/caddy/Caddyfile
install -m 0644 -o root -g root "$SCRIPT_DIRECTORY/kairos-server.service" /etc/systemd/system/kairos-server.service
install -m 0644 -o root -g root "$SCRIPT_DIRECTORY/kairos-caddy.service" /etc/systemd/system/kairos-caddy.service

if [[ ! -e /etc/kairos/server.env ]]; then
  install -m 0600 -o root -g root "$SCRIPT_DIRECTORY/server.example.env" /etc/kairos/server.env
fi
if grep -q '^KAIROS_AUTH_SECRET=replace-with-independent-random-secret$' /etc/kairos/server.env; then
  AUTH_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  sed -i "s/^KAIROS_AUTH_SECRET=.*/KAIROS_AUTH_SECRET=$AUTH_SECRET/" /etc/kairos/server.env
  unset AUTH_SECRET
fi
chown root:root /etc/kairos/server.env
chmod 0600 /etc/kairos/server.env

install -d -m 0750 -o kairos -g kairos /workspace
install -d -m 0750 -o root -g kairos /etc/kairos-daemon
install -d -m 0700 -o kairos -g kairos /var/lib/kairos-daemon
install -d -m 0755 -o root -g root /opt/kairos-daemon/releases
if [[ ! -e /etc/kairos-daemon/config.env ]]; then
  printf 'KAIROS_DEVICE_SERVER_URL=ws://127.0.0.1:4317/devices/wss\nKAIROS_DEVICE_IDENTITY_PATH=/var/lib/kairos-daemon/identity.json\n' \
    >/etc/kairos-daemon/config.env
fi
chown root:kairos /etc/kairos-daemon/config.env
chmod 0640 /etc/kairos-daemon/config.env

DAEMON_BASENAME=$(basename "$DAEMON_ARCHIVE")
install -m 0640 -o root -g kairos-server "$DAEMON_ARCHIVE" "/opt/kairos/daemon-releases/$DAEMON_BASENAME"
install -m 0640 -o root -g kairos-server "$DAEMON_MANIFEST" /opt/kairos/daemon-releases/release-linux-x64.json
STAGING=/opt/kairos-daemon/.install-$$
mkdir "$STAGING"
trap 'rm -rf "$STAGING"' EXIT
if tar -tzf "$DAEMON_ARCHIVE" | awk '/^\// || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  printf 'error: unsafe Daemon archive paths.\n' >&2
  exit 1
fi
mkdir "$STAGING/release"
tar -xzf "$DAEMON_ARCHIVE" -C "$STAGING/release"
(cd "$STAGING/release" && sha256sum --quiet -c SHA256SUMS)
VERSION=$(<"$STAGING/release/VERSION")
[[ $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$ ]]
TARGET=/opt/kairos-daemon/releases/$VERSION
[[ ! -e $TARGET ]] || { printf 'error: Daemon release already exists: %s.\n' "$TARGET" >&2; exit 1; }
mv "$STAGING/release" "$TARGET"
chown -R root:root "$TARGET"
ln -sfn "$TARGET" /opt/kairos-daemon/current.new
mv -Tf /opt/kairos-daemon/current.new /opt/kairos-daemon/current
install -m 0644 -o root -g root "$TARGET/systemd/kairos-daemon.service" /etc/systemd/system/kairos-daemon.service

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/kairos-server.service \
  /etc/systemd/system/kairos-caddy.service /etc/systemd/system/kairos-daemon.service
"$CADDY" validate --config /etc/kairos/caddy/Caddyfile --adapter caddyfile
systemctl enable kairos-caddy.service
printf 'Installed service configuration. Caddy is enabled; Server and Daemon remain stopped until authentication and pairing are configured.\n'
