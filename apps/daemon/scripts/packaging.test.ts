import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packaging = join(repository, 'apps/daemon/packaging');
const scripts = [
  'install.sh',
  'upgrade.sh',
  'uninstall.sh',
  'lib/platform.sh',
  'macos/common.sh',
  'macos/control.sh',
  'macos/install.sh',
  'macos/upgrade.sh',
  'macos/uninstall.sh',
  'systemd/control.sh',
  'systemd/control-home.sh',
];

function text(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Daemon packaging static checks', () => {
  it('passes shell and JavaScript syntax checks', () => {
    for (const script of scripts) {
      execFileSync('bash', ['-n', join(packaging, script)], { stdio: 'pipe' });
    }
    execFileSync(process.execPath, [
      '--check',
      join(repository, 'scripts/build-daemon-release.mjs'),
    ]);
    execFileSync(process.execPath, [
      '--check',
      join(repository, 'apps/daemon/scripts/release-smoke.mjs'),
    ]);
    execFileSync('sh', ['-n', join(packaging, 'bin/kairos-daemon')]);
  });

  it('limits installation to Ubuntu 22.04/24.04 x86_64 with systemd and a non-root service', () => {
    const platform = text(join(packaging, 'lib/platform.sh'));
    expect(platform).toContain('VERSION_ID:-} == 22.04');
    expect(platform).toContain('VERSION_ID:-} == 24.04');
    expect(platform).toContain('$(uname -m) == x86_64');
    expect(platform).toContain('/proc/1/comm');
    expect(platform).toContain('EUID');
    const unit = text(join(packaging, 'systemd/kairos-daemon.service'));
    expect(unit).toContain('User=kairos');
    expect(unit).toContain('Group=kairos');
    expect(unit).toContain('ExecStart=/opt/kairos-daemon/current/bin/kairos-daemon');
    expect(unit).toContain('RestartPreventExitStatus=78');
    expect(unit).not.toContain('User=root');
    const launcher = text(join(packaging, 'bin/kairos-daemon'));
    expect(launcher).toContain('"$RELEASE_ROOT/node/bin/node"');
    expect(launcher).not.toContain('pnpm');
  });

  it('uses a staged candidate control client before stopping the old service', () => {
    const upgrade = text(join(packaging, 'upgrade.sh'));
    const drains = [
      ...upgrade.matchAll(/runuser -u kairos -- "\$TARGET\/bin\/kairos-daemon" drain/g),
    ];
    expect(drains).toHaveLength(2);
    expect(upgrade.indexOf('kairos_verify_release "$TARGET"')).toBeLessThan(drains[0]?.index ?? 0);
    expect(drains[0]?.index).toBeLessThan(upgrade.indexOf('systemctl stop'));
    expect(drains[1]?.index).toBeGreaterThan(upgrade.indexOf('systemctl stop'));
    expect(upgrade).not.toContain('runuser -u kairos -- "$CURRENT/bin/kairos-daemon" drain');
    expect(upgrade).not.toContain('runuser -u kairos -- "$RELEASE_ROOT/bin/kairos-daemon" drain');
    expect(upgrade).toContain('runuser -u kairos -- "$TARGET/bin/kairos-daemon" --check');
    expect(upgrade.indexOf(' drain ')).toBeLessThan(upgrade.indexOf('current.new'));
    expect(upgrade).toContain('--expected-version');
    expect(upgrade).toContain('maintenance remains draining');
    const uninstall = text(join(packaging, 'uninstall.sh'));
    expect(uninstall.indexOf('systemctl stop')).toBeLessThan(uninstall.indexOf(' revoke'));
    const install = text(join(packaging, 'install.sh'));
    expect(install.indexOf('systemctl stop')).toBeLessThan(install.indexOf(' pair-once'));
    expect(install).toContain('runuser -u kairos');
    expect(install).not.toContain('KAIROS_DEVICE_PAIRING_CREDENTIAL=');
  });

  it('isolates macOS environments and manages an idempotent user control entry', () => {
    const install = text(join(packaging, 'macos/install.sh'));
    const common = text(join(packaging, 'macos/common.sh'));
    const upgrade = text(join(packaging, 'macos/upgrade.sh'));
    const uninstall = text(join(packaging, 'macos/uninstall.sh'));
    expect(install).toContain('PREFIX=$BASE_PREFIX/environments/$ENV_ID');
    expect(install).not.toContain('LEGACY_IDENTITY');
    expect(upgrade).not.toContain('PREFIX=$BASE_PREFIX\n');
    expect(uninstall).not.toContain('PREFIX=$BASE_PREFIX\n');
    expect(install).toContain('%s status %s');
    expect(install).toContain('%s stop %s');
    expect(install).toContain('%s start %s');
    expect(common).toContain('CONTROL_LINK=$CONTROL_DIRECTORY/kairos-daemon');
    expect(common).toContain('shasum -a 256');
    expect(common).toContain('kairos_macos_verify_pid');
    expect(common).not.toContain('kickstart -kp');
    expect(common).toContain('launchd service is already active');
    expect(common).toContain('current/macos/control.sh');
    expect(text(join(packaging, 'macos/control.sh'))).toContain('TARGET=$(readlink "$TARGET")');
    const drains = [...upgrade.matchAll(/"\$RELEASE_ROOT\/bin\/kairos-daemon" drain/g)];
    expect(drains).toHaveLength(2);
    expect(drains[0]?.index).toBeLessThan(upgrade.indexOf('\nkairos_macos_stop'));
    expect(drains[1]?.index).toBeGreaterThan(upgrade.indexOf('\nkairos_macos_stop'));
    expect(upgrade).not.toContain('"$PREFIX/current/bin/kairos-daemon" drain');
    expect(upgrade).toContain('--env-id');
    expect(upgrade).toContain('kairos_macos_control_link');
    expect(uninstall).toContain('kairos_macos_remove_control_link');

    const linuxInstall = text(join(packaging, 'install.sh'));
    const linuxUpgrade = text(join(packaging, 'upgrade.sh'));
    expect(linuxInstall).toContain('"$CONTROL_LINK" start "$ENV_ID"');
    expect(linuxUpgrade).toContain('"$CONTROL_LINK" start "$ENV_ID"');
  });

  it('keeps Linux identity access behind the service account and installs control into the sudo user home', () => {
    const home = text(join(packaging, 'systemd/control-home.sh'));
    const control = text(join(packaging, 'systemd/control.sh'));
    const install = text(join(packaging, 'install.sh'));
    const upgrade = text(join(packaging, 'upgrade.sh'));
    const uninstall = text(join(packaging, 'uninstall.sh'));
    expect(home).toContain(`CONTROL_USER=\${SUDO_USER:-root}`);
    expect(home).toContain('getent passwd "$CONTROL_USER"');
    expect(home).toContain('IFS=: read -r _ _ _ _ _ CONTROL_HOME _');
    expect(home).toContain('CONTROL_DIRECTORY=$CONTROL_HOME/.local/bin');
    expect(home).toContain('install -d -m 0755 -o "$CONTROL_USER" -g "$CONTROL_GROUP"');
    expect(home).toContain("printf 'CONTROL_USER=%q\\nCONTROL_HOME=%q\\n'");
    expect(home).toContain('target=$1/current/systemd/control.sh');
    expect(home).not.toContain('/var/lib');
    expect(control).toContain('exec sudo "$TARGET" "$@"');
    expect(control).not.toContain('sudo -n');
    expect(control.indexOf('if [[ $EUID -ne 0 ]]')).toBeLessThan(control.indexOf('case $COMMAND'));
    expect(control).toContain(
      'runuser -u kairos -- "$RELEASE_ROOT/bin/kairos-daemon" identity-env',
    );
    expect(control).toContain(
      'runuser -u kairos -- "$RELEASE_ROOT/bin/kairos-daemon" status "$ENV_ID"',
    );
    expect(control).toContain('systemctl start kairos-daemon.service');
    expect(control).toContain('systemctl stop kairos-daemon.service');
    expect(control).not.toContain('chmod 0666');
    expect(install).toContain('kairos_control_resolve "$CONFIG_DIRECTORY"');
    expect(upgrade).toContain('kairos_control_resolve /etc/kairos-daemon');
    expect(uninstall).toContain('kairos_control_remove_link /opt/kairos-daemon');

    const smoke = text(join(repository, 'apps/daemon/scripts/release-smoke.mjs'));
    expect(smoke).toContain('async function linuxSystemdSmoke()');
    expect(smoke).toContain('process.getuid?.() !== 0');
    expect(smoke).toContain('uid: ordinaryUid');
    expect(smoke).toContain('gid: ordinaryGid');
    expect(smoke).toContain('SUDO_USER: user');
    expect(smoke).toContain("runAsUser('start')");
    expect(smoke).toContain("runAsUser('stop')");
    expect(smoke).toContain('ordinaryUserEntryAccessible: true');
    expect(smoke).toContain('interactiveSudoPrompt: true');
    expect(smoke).toContain('sudoTimestampClearedPerCommand: true');
    expect(smoke).toContain('chpasswd');
    expect(smoke).toContain('sudo -k');
    expect(smoke).toContain('stty -echo');
    expect(smoke).not.toContain('NOPASSWD');
  });

  it('passes the systemd identity path to every pairing, drain and revocation command', () => {
    const install = text(join(packaging, 'install.sh'));
    const upgrade = text(join(packaging, 'upgrade.sh'));
    const uninstall = text(join(packaging, 'uninstall.sh'));
    expect(install).toContain('STATE_DIRECTORY=/var/lib/kairos-daemon');
    expect(install).toContain('IDENTITY_PATH=$STATE_DIRECTORY/identity.json');
    expect(install).toContain('KAIROS_DEVICE_IDENTITY_PATH=%s');
    expect(upgrade).toContain('IDENTITY_PATH=/var/lib/kairos-daemon/identity.json');
    expect(uninstall).toContain('IDENTITY_PATH=/var/lib/kairos-daemon/identity.json');
    expect(text(join(packaging, 'systemd/kairos-daemon.service'))).toContain(
      'EnvironmentFile=-/etc/kairos-daemon/config.env',
    );

    const commands = [install, upgrade, uninstall].flatMap((script) =>
      (script.replace(/\\\n/g, '').match(/runuser -u kairos --[^\n]*/g) ?? []).filter((command) =>
        /\b(pair-once|drain|revoke)\b/.test(command),
      ),
    );
    expect(commands).toHaveLength(5);
    for (const command of commands) {
      expect(command).toMatch(/\b(pair-once|drain|revoke)\b/);
      expect(command).toContain('--identity-path "$IDENTITY_PATH"');
    }
  });

  it('records both Ubuntu versions as unverified and never invents release endpoints', () => {
    const build = text(join(repository, 'scripts/build-daemon-release.mjs'));
    expect(build).toContain("readFileSync(join(repository, '.node-version'), 'utf8')");
    expect(build).toContain("let TARGET = 'ubuntu22.04-24.04-x86_64'");
    expect(build).toContain('ubuntu22.04_systemd_acceptance=unverified');
    expect(build).toContain('ubuntu24.04_systemd_acceptance=unverified');
    expect(build).toContain('release_download_url=unconfigured');
    expect(build).toContain('release_signature_verification=unverified_no_public_key');
    expect(build).toContain("deploy', '--prod', '--legacy");
    expect(build).not.toContain('example.com');
  });
});
