import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SessionError } from '../sessions/errors.js';
import type { EnvironmentPairingIssue } from './environment-store.js';

const releaseSchema = z.object({
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/),
  platform: z.enum(['linux', 'darwin']),
  architecture: z.enum(['x64', 'arm64']),
  file: z.string().regex(/^kairos-daemon-[0-9A-Za-z.+_-]+\.tar\.gz$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const targets = ['linux-x64', 'darwin-arm64', 'darwin-x64'] as const;

export interface DaemonCommandGuide {
  startCommand: string;
  statusCommand: string;
  stopCommand: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export class DeviceInstaller {
  private readonly origin: string;
  constructor(
    private readonly directory: string,
    origin: string,
  ) {
    const url = new URL(origin);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
      throw new Error('Device installer requires a public HTTP(S) origin.');
    this.origin = url.origin;
  }

  private release(target: string) {
    if (!targets.some((value) => value === target))
      throw new SessionError('not_found', 'Device platform is unsupported.');
    const metadata = join(this.directory, `release-${target}.json`);
    if (!existsSync(metadata))
      throw new SessionError(
        'failed_precondition',
        `Device installation package ${target} is unavailable. Build and configure the release directory first.`,
      );
    if (statSync(metadata).size > 16 * 1024)
      throw new SessionError('internal', 'Device release metadata is too large.');
    const release = releaseSchema.parse(JSON.parse(readFileSync(metadata, 'utf8')));
    if (`${release.platform}-${release.architecture}` !== target)
      throw new SessionError('internal', 'Device release target is inconsistent.');
    const path = realpathSync(join(this.directory, release.file));
    const root = realpathSync(this.directory);
    const info = statSync(path);
    if (!path.startsWith(`${root}${sep}`) || !info.isFile() || info.size > 256 * 1024 * 1024)
      throw new SessionError('internal', 'Device release artifact is invalid.');
    return { ...release, path };
  }

  assertAvailable(): void {
    if (!targets.some((target) => existsSync(join(this.directory, `release-${target}.json`))))
      throw new SessionError(
        'failed_precondition',
        'Device installation packages are unavailable. Build and configure KAIROS_DAEMON_RELEASE_DIR.',
      );
    for (const target of targets)
      if (existsSync(join(this.directory, `release-${target}.json`))) this.release(target);
  }

  daemonCommands(envId: string): DaemonCommandGuide {
    if (!/^[0-9A-Za-z._:-]{1,200}$/.test(envId))
      throw new SessionError('internal', 'Environment identifier is invalid for Daemon commands.');
    return {
      startCommand: `~/.local/bin/kairos-daemon start ${envId}`,
      statusCommand: `~/.local/bin/kairos-daemon status ${envId}`,
      stopCommand: `~/.local/bin/kairos-daemon stop ${envId}`,
    };
  }

  command(issued: EnvironmentPairingIssue): string {
    const websocket = new URL('/devices/wss', this.origin);
    websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:';
    const script =
      'set -eu; file=$(mktemp); trap \'rm -f "$file"\' EXIT; curl --fail --silent --show-error --location "$1" -o "$file"; bash "$file" --env-id "$2" --server-url "$3" --directory "$4"';
    return `printf '%s\\n' ${quote(issued.pairingCredential)} | bash -c ${quote(script)} -- ${quote(`${this.origin}/api/daemon/install.sh`)} ${quote(issued.environment.envId)} ${quote(websocket.toString())} ${quote(issued.environment.autoDetect ? '' : issued.environment.recommendedPwd)}`;
  }

  register(server: FastifyInstance): void {
    for (const prefix of ['/daemon', '/api/daemon']) {
      server.get(`${prefix}/install.sh`, async (_request, reply) =>
        reply.type('text/x-shellscript').header('Cache-Control', 'no-store').send(this.bootstrap()),
      );
      server.get<{ Params: { platform: string; architecture: string } }>(
        `${prefix}/releases/:platform/:architecture`,
        async (request, reply) => {
          try {
            const release = this.release(
              `${request.params.platform}-${request.params.architecture}`,
            );
            return reply
              .type('text/plain')
              .header('Cache-Control', 'no-store')
              .send(`${release.file}\n${release.sha256}\n${release.version}\n`);
          } catch (error) {
            return reply
              .code(error instanceof SessionError && error.code === 'not_found' ? 404 : 503)
              .type('text/plain')
              .send('Device installation package is unavailable.');
          }
        },
      );
      server.get<{ Params: { file: string } }>(
        `${prefix}/artifacts/:file`,
        async (request, reply) => {
          for (const target of targets) {
            if (!existsSync(join(this.directory, `release-${target}.json`))) continue;
            const release = this.release(target);
            if (
              release.file === basename(request.params.file) &&
              release.file === request.params.file
            )
              return reply
                .type('application/gzip')
                .header('Cache-Control', 'public, max-age=31536000, immutable')
                .send(createReadStream(release.path));
          }
          return reply.code(404).send();
        },
      );
    }
  }

  private bootstrap(): string {
    return String.raw`#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
BASE=${quote(`${this.origin}/api/daemon`)}
ENV_ID=
SERVER_URL=
DIRECTORY=
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-id) ENV_ID=$2; shift 2 ;;
    --server-url) SERVER_URL=$2; shift 2 ;;
    --directory) DIRECTORY=$2; shift 2 ;;
    *) printf 'Unsupported installer argument.\n' >&2; exit 78 ;;
  esac
done
[[ -n $ENV_ID && -n $SERVER_URL ]] || exit 78
IFS= read -r PAIRING_CREDENTIAL
case $(uname -s) in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) printf 'Unsupported operating system.\n' >&2; exit 78 ;;
esac
case $(uname -m) in
  x86_64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) printf 'Unsupported architecture.\n' >&2; exit 78 ;;
esac
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 180 "$BASE/releases/$PLATFORM/$ARCH" -o "$WORK/metadata"
FILE=$(sed -n '1p' "$WORK/metadata")
HASH=$(sed -n '2p' "$WORK/metadata")
[[ $FILE =~ ^kairos-daemon-[0-9A-Za-z.+_-]+\.tar\.gz$ && $HASH =~ ^[a-f0-9]{64}$ ]] || exit 78
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 180 --max-filesize 268435456 "$BASE/artifacts/$FILE" -o "$WORK/release.tar.gz"
if [[ $PLATFORM == darwin ]]; then ACTUAL=$(shasum -a 256 "$WORK/release.tar.gz" | awk '{print $1}'); else ACTUAL=$(sha256sum "$WORK/release.tar.gz" | awk '{print $1}'); fi
[[ $ACTUAL == "$HASH" ]] || { printf 'Release checksum verification failed.\n' >&2; exit 78; }
tar -tzf "$WORK/release.tar.gz" > "$WORK/contents"
if awk '/^\// || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit !bad }' "$WORK/contents"; then printf 'Unsafe release archive.\n' >&2; exit 78; fi
mkdir "$WORK/release"
tar -xzf "$WORK/release.tar.gz" -C "$WORK/release"
set -- --env-id "$ENV_ID" --server-url "$SERVER_URL"
if [[ -n $DIRECTORY ]]; then set -- "$@" --directory "$DIRECTORY"; fi
if [[ $PLATFORM == linux && $EUID -ne 0 ]]; then
  sudo -v
  printf '%s\n' "$PAIRING_CREDENTIAL" | sudo bash "$WORK/release/install.sh" "$@"
else
  printf '%s\n' "$PAIRING_CREDENTIAL" | bash "$WORK/release/install.sh" "$@"
fi
unset PAIRING_CREDENTIAL
`;
  }
}
