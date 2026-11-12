import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const deployment = join(repository, 'deploy/k1');
const shellScripts = readdirSync(deployment).filter((name) => name.endsWith('.sh'));

function run(root, args, options = {}) {
  const trace = process.env.KAIROS_TEST_TRACE === '1' ? ['-x'] : [];
  return execFileSync('bash', [...trace, join(root, 'scripts/kairos.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: options.path ?? process.env.PATH,
      HOME: root,
      KAIROS_ROOT: root,
      KAIROS_CHAMBER_BIN: join(root, 'fake-bin/chamber'),
      FAKE_TMUX_STATE: join(root, 'fake-tmux'),
      FAKE_MIGRATION_LOG: join(root, 'migration.log'),
      FAKE_MIGRATION_STATUS: options.migrationStatus ?? 'current',
      FAIL_RESTORE_COPY: options.failRestoreCopy ? '1' : '',
    },
    stdio: ['ignore', 'pipe', trace.length > 0 ? 'inherit' : 'pipe'],
    timeout: Number(process.env.KAIROS_TEST_TIMEOUT ?? 30_000),
  });
}

async function waitForFile(path, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function files(root, directory = root) {
  const result = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...files(root, path));
    else if (item.isFile()) result.push(relative(root, path).split(sep).join('/'));
  }
  return result;
}

function makeRelease(root, version) {
  const release = join(root, 'incoming', version);
  mkdirSync(join(release, 'app/apps/server/dist'), { recursive: true });
  mkdirSync(join(release, 'gui'), { recursive: true });
  mkdirSync(join(release, 'workspace'), { recursive: true });
  mkdirSync(join(release, 'caddy'), { recursive: true });
  writeFileSync(join(release, 'app/apps/server/dist/main.js'), '');
  writeFileSync(
    join(release, 'app/apps/server/dist/migrate.js'),
    `import fs from 'node:fs';
const check = process.argv.includes('--check');
if (check) console.log(JSON.stringify({ status: process.env.FAKE_MIGRATION_STATUS, databasePath: 'controlled', namespaces: [] }));
else {
  fs.appendFileSync(process.env.FAKE_MIGRATION_LOG, 'migrated\\n');
  console.log(JSON.stringify({ status: 'current', databasePath: 'controlled', namespaces: [], backupPath: 'controlled-backup' }));
}
`,
  );
  writeFileSync(join(release, 'gui/index.html'), version);
  writeFileSync(join(release, 'workspace/AGENTS.md'), `workspace ${version}\n`);
  cpSync(join(repository, 'deploy/caddy/Caddyfile'), join(release, 'caddy/Caddyfile'));
  cpSync(deployment, join(release, 'operations'), { recursive: true });
  writeFileSync(join(release, 'release.json'), JSON.stringify({ version, sourceCommit: version }));
  const sums = files(release)
    .sort()
    .map(
      (path) =>
        `${createHash('sha256')
          .update(readFileSync(join(release, path)))
          .digest('hex')}  ${path}`,
    );
  writeFileSync(join(release, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return release;
}

function prepare(t) {
  const root = mkdtempSync(join(tmpdir(), 'kairos-operations-test-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(deployment, join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'runtime/node-v26.4.0-linux-x64/bin'), { recursive: true });
  symlinkSync(process.execPath, join(root, 'runtime/node-v26.4.0-linux-x64/bin/node'));
  mkdirSync(join(root, 'runtime/caddy-2.10.2'), { recursive: true });
  executable(join(root, 'runtime/caddy-2.10.2/caddy'), '#!/usr/bin/env bash\nexit 0\n');
  mkdirSync(join(root, 'fake-bin'), { recursive: true });
  executable(join(root, 'fake-bin/chamber'), '#!/usr/bin/env bash\nexit 0\n');
  executable(
    join(root, 'fake-bin/cp'),
    `#!/usr/bin/env bash
if [[ "$FAIL_RESTORE_COPY" == 1 && " $* " == *".prod.restore-new-"* && " $* " == *"/data"* ]]; then
  printf 'controlled restore copy failure\\n' >&2
  exit 1
fi
exec /bin/cp "$@"
`,
  );
  executable(
    join(root, 'fake-bin/curl'),
    '#!/usr/bin/env bash\nprintf \'{"service":"kairos-server","status":"ok"}\\n\'\n',
  );
  executable(
    join(root, 'fake-bin/tmux'),
    `#!/usr/bin/env bash
state=$FAKE_TMUX_STATE
mkdir -p "$state"
if [[ " $* " == *" has-session "* ]]; then
  exit 1
fi
if [[ " $* " == *" display-message "* ]]; then
  role=server
  if [[ " $* " == *":entry "* ]]; then role=entry; fi
  sleep 300 >/dev/null 2>&1 </dev/null &
  echo $! > "$state/$role.pid"
  cat "$state/$role.pid"
fi
exit 0
`,
  );
  run(root, ['init']);
  for (const environment of ['prod', 'test']) {
    const directory = join(root, environment);
    writeFileSync(
      join(directory, 'config.env'),
      `NODE_ENV=production
KAIROS_HOST=127.0.0.1
KAIROS_PORT=${environment === 'prod' ? 4317 : 4318}
KAIROS_CADDY_PORT=${environment === 'prod' ? 14317 : 14318}
KAIROS_CHAMBER_SERVICE=kairos-controlled-${environment}
KAIROS_PUBLIC_ORIGIN=https://controlled.invalid
KAIROS_DATA_DIR=${directory}/data
KAIROS_DAEMON_RELEASE_DIR=${directory}/daemon-releases
`,
    );
  }
  const path = `${join(root, 'fake-bin')}:${process.env.PATH}`;
  t.after(() => {
    if (existsSync(join(root, 'fake-tmux'))) {
      for (const file of readdirSync(join(root, 'fake-tmux'))) {
        const pid = Number(readFileSync(join(root, 'fake-tmux', file), 'utf8'));
        if (Number.isInteger(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path };
}

test('deployment scripts pass syntax checks and avoid unrelated process or host controls', () => {
  for (const script of shellScripts) execFileSync('bash', ['-n', join(deployment, script)]);
  execFileSync(process.execPath, ['--check', join(deployment, 'verify-release.mjs')]);
  execFileSync(process.execPath, ['--check', join(repository, 'scripts/build-server-release.mjs')]);
  execFileSync(process.execPath, ['--check', join(repository, 'deploy/server-release-smoke.mjs')]);
  const all = shellScripts
    .map((script) => readFileSync(join(deployment, script), 'utf8'))
    .join('\n');
  assert.doesNotMatch(all, /\b(pkill|killall|systemctl|loginctl|sudo|docker)\b/);
  assert.doesNotMatch(all, /\/mnt(?:\/|\s|$)/);
  assert.match(all, /RESTARTS >= 3/);
  const caddy = readFileSync(join(repository, 'deploy/caddy/Caddyfile'), 'utf8');
  assert.match(caddy, /strip_prefix \/api/);
  assert.match(caddy, /@server path \/devices\/wss \/health/);
  assert.match(caddy, /try_files \{path\} \/index.html/);
  assert.match(caddy, /flush_interval -1/);
  const cvmCaddy = readFileSync(join(repository, 'deploy/cvm/Caddyfile'), 'utf8');
  assert.match(cvmCaddy, /default_sni 43\.142\.128\.4/);
  assert.match(cvmCaddy, /tls force_automate \{/);
  assert.match(cvmCaddy, /issuer acme \{\s+profile shortlived\s+\}/);
  assert.doesNotMatch(cvmCaddy, /tls internal/);
  const cvmEnvironment = readFileSync(join(repository, 'deploy/cvm/server.example.env'), 'utf8');
  assert.match(cvmEnvironment, /^KAIROS_PUBLIC_ORIGIN=https:\/\/43\.142\.128\.4$/m);
});

test('runtime verification parses official SHA-256 and SHA-512 manifests', (t) => {
  const library = join(deployment, 'runtime-lib.sh');
  const fixtures = join(repository, 'deploy/tests/fixtures');
  const cases = [
    {
      sums: join(fixtures, 'node-v26.4.0-SHASUMS256.txt'),
      archive: 'node-v26.4.0-linux-x64.tar.gz',
      algorithm: '256',
      expected: 'f221dab30d0e9d544332f06fbee2c62186c97d864d5cac8482dba34f1e38b8dc',
    },
    {
      sums: join(fixtures, 'caddy_2.10.2_checksums.txt'),
      archive: 'caddy_2.10.2_linux_amd64.tar.gz',
      algorithm: '512',
      expected:
        '747df7ee74de188485157a383633a1a963fd9233b71fbb4a69ddcbcc589ce4e2cc82dacf5dbbe136cb51d17e14c59daeb5d9bc92487610b0f3b93680b2646546',
    },
  ];
  for (const item of cases) {
    const actual = execFileSync(
      'bash',
      [
        '-c',
        '. "$1"; official_checksum "$2" "$3" "$4"',
        '_',
        library,
        item.sums,
        item.archive,
        item.algorithm,
      ],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(actual, item.expected);
    assert.equal(actual.length, Number(item.algorithm) / 4);

    const temporary = mkdtempSync(join(tmpdir(), 'kairos-checksum-test-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const archive = join(temporary, item.archive);
    writeFileSync(archive, item.archive);
    const digest = createHash(`sha${item.algorithm}`).update(item.archive).digest('hex');
    writeFileSync(join(temporary, 'sums'), `${digest}  ${item.archive}\n`);
    execFileSync('bash', [
      '-c',
      '. "$1"; verify_archive "$2" "$3" "$4"',
      '_',
      library,
      join(temporary, 'sums'),
      archive,
      item.algorithm,
    ]);
    appendFileSync(archive, 'changed');
    assert.throws(() =>
      execFileSync(
        'bash',
        [
          '-c',
          '. "$1"; verify_archive "$2" "$3" "$4"',
          '_',
          library,
          join(temporary, 'sums'),
          archive,
          item.algorithm,
        ],
        { stdio: 'pipe' },
      ),
    );
  }
});

test('real download fetches fresh content after checksum failure and reuses only valid cache', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-download-retry-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const archive = join(temporary, 'artifact.tar.gz');
  const validContent = 'valid-new-content';
  const digest = createHash('sha256').update(validContent).digest('hex');
  writeFileSync(join(temporary, 'sums'), `${digest}  artifact.tar.gz\n`);
  const script = `
set -euo pipefail
. "$1"
CURL_CALLS=0
curl() {
  local output=''
  while (($#)); do
    if [[ "$1" == --output ]]; then output=$2; shift 2; else shift; fi
  done
  CURL_CALLS=$((CURL_CALLS + 1))
  if ((CURL_CALLS == 1)); then printf 'corrupt' > "$output";
  else printf 'valid-new-content' > "$output"; fi
}
download controlled://artifact "$2"
if verify_archive "$3" "$2" 256; then exit 90; fi
[[ ! -e "$2" ]]
download controlled://artifact "$2"
verify_archive "$3" "$2" 256
[[ "$(< "$2")" == valid-new-content ]]
download controlled://artifact "$2"
[[ "$CURL_CALLS" -eq 2 ]]
printf 'corrupt-again' > "$2"
if verify_archive "$3" "$2" 256; then exit 91; fi
[[ ! -e "$2" ]]
download controlled://artifact "$2"
verify_archive "$3" "$2" 256
[[ "$CURL_CALLS" -eq 3 ]]
`;
  execFileSync(
    'bash',
    ['-c', script, '_', join(deployment, 'runtime-lib.sh'), archive, join(temporary, 'sums')],
    {
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  assert.equal(readFileSync(archive, 'utf8'), validContent);
});

test('runtime verification failure leaves no final runtime and remains retryable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kairos-runtime-retry-'));
  const log = join(root, 'calls.log');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installer = join(deployment, 'runtime-install.sh');
  const script = `
. "$1"
uname() { if [[ "$1" == -s ]]; then printf 'Linux\\n'; else printf 'x86_64\\n'; fi; }
download() { printf 'download %s\\n' "$1" >> "$TEST_LOG"; }
verify_archive() {
  printf 'verify %s %s\\n' "$2" "$3" >> "$TEST_LOG"
  if [[ "$3" == 512 ]]; then printf 'controlled checksum failure\\n' >&2; return 1; fi
}
main
`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () =>
        execFileSync('bash', ['-c', script, '_', installer], {
          env: { PATH: process.env.PATH, KAIROS_RUNTIME_ROOT: root, TEST_LOG: log },
          encoding: 'utf8',
        }),
      /controlled checksum failure/,
    );
    for (const target of ['node-v26.4.0-linux-x64', 'pnpm-11.22.0', 'caddy-2.10.2']) {
      assert.equal(existsSync(join(root, 'runtime', target)), false);
    }
  }
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /SHASUMS256/);
  assert.equal(calls.match(/^download /gm)?.length, 8);
  assert.equal(calls.match(/^verify .* 512$/gm)?.length, 2);
  assert.equal(
    readdirSync(join(root, 'runtime')).some((name) => name.startsWith('.install-')),
    false,
  );
  const installerText = readFileSync(installer, 'utf8');
  for (const setting of [
    'npm_config_cache',
    'npm_config_logs_dir',
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
  ]) {
    assert.match(installerText, new RegExp(`${setting}=.*runtime`));
  }
});

test('runner cleans a surviving Caddy process group before every chamber restart', (t) => {
  const { root, path } = prepare(t);
  const version = '3'.repeat(40);
  makeRelease(root, version);
  run(root, ['install', join(root, 'incoming', version)], { path });
  symlinkSync(join(root, 'releases', version), join(root, 'prod/current'));
  const children = join(root, 'caddy-children.log');
  writeFileSync(children, '');
  executable(
    join(root, 'fake-bin/chamber'),
    `#!/usr/bin/env bash
sleep 300 >/dev/null 2>&1 </dev/null &
printf '%s\\n' "$!" >> "$FAKE_CADDY_PID_LOG"
exit 1
`,
  );
  assert.throws(() =>
    execFileSync('bash', [join(root, 'scripts/runner.sh'), 'prod', 'entry'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: path,
        HOME: root,
        KAIROS_ROOT: root,
        KAIROS_CHAMBER_BIN: join(root, 'fake-bin/chamber'),
        FAKE_CADDY_PID_LOG: children,
        KAIROS_RESTART_DELAY: '0.1',
      },
      timeout: 20_000,
    }),
  );
  const pids = readFileSync(children, 'utf8').split('\n').filter(Boolean);
  assert.equal(pids.length, 4);
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {}
    }
  });
  for (const pid of pids) {
    const state = execFileSync(
      'bash',
      ['-c', 'ps -p "$1" -o stat= 2>/dev/null || true', '_', pid],
      {
        encoding: 'utf8',
      },
    ).trim();
    assert.ok(
      state === '' || state.startsWith('Z'),
      `Caddy descendant ${pid} is still active: ${state}`,
    );
  }
  assert.match(readFileSync(join(root, 'prod/logs/entry.log'), 'utf8'), /restart 3 of 3/);
});

test('operator stop allows a five-second graceful shutdown without duplicate group TERM', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-supervisor-stop-'));
  const supervisor = join(deployment, 'process-supervisor.mjs');
  const child = join(temporary, 'child.mjs');
  const events = join(temporary, 'events.log');
  const log = join(temporary, 'service.log');
  const pidFile = join(temporary, 'supervisor.pid');
  const status = join(temporary, 'status');
  writeFileSync(
    child,
    `import { appendFileSync } from 'node:fs';
const events = process.argv[2];
process.on('SIGTERM', () => {
  appendFileSync(events, 'child-term\\n');
  setTimeout(() => {
    appendFileSync(events, 'child-graceful-exit\\n');
    process.exit(0);
  }, 5000);
});
appendFileSync(events, 'child-ready\\n');
setInterval(() => {}, 1000);
`,
  );
  const script = `
set -m
"$1" "$2" -- "$1" "$3" "$4" >"$5" 2>&1 &
supervisor=$!
printf '%s\\n' "$supervisor" > "$6"
set +e
wait "$supervisor"
printf '%s\\n' "$?" > "$7"
`;
  const shell = spawn(
    'bash',
    ['-c', script, '_', process.execPath, supervisor, child, events, log, pidFile, status],
    { stdio: 'ignore' },
  );
  t.after(() => {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    shell.kill('SIGKILL');
    rmSync(temporary, { recursive: true, force: true });
  });
  await waitForFile(events);
  await waitForFile(pidFile);
  const supervisorPid = Number(readFileSync(pidFile, 'utf8'));
  const started = Date.now();
  process.kill(-supervisorPid, 'SIGTERM');
  await waitForFile(status, 12_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4000, `Graceful shutdown was interrupted after ${elapsed} ms`);
  const output = readFileSync(events, 'utf8');
  assert.equal(output.match(/^child-term$/gm)?.length, 1);
  assert.equal(output.match(/^child-graceful-exit$/gm)?.length, 1);
  assert.equal(readFileSync(status, 'utf8').trim(), '143');
});

test('supervisor forwards child stdout and stderr to the service log', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-supervisor-log-'));
  const supervisor = join(deployment, 'process-supervisor.mjs');
  const child = join(temporary, 'child.mjs');
  const log = join(temporary, 'service.log');
  const pidFile = join(temporary, 'supervisor.pid');
  const status = join(temporary, 'status');
  writeFileSync(
    child,
    `process.stdout.write('controlled-stdout\\n');
process.stderr.write('controlled-stderr\\n');
`,
  );
  const script = `
set -m
"$1" "$2" -- "$1" "$3" >"$4" 2>&1 &
supervisor=$!
printf '%s\\n' "$supervisor" > "$5"
set +e
wait "$supervisor"
printf '%s\\n' "$?" > "$6"
`;
  const shell = spawn(
    'bash',
    ['-c', script, '_', process.execPath, supervisor, child, log, pidFile, status],
    { stdio: 'ignore' },
  );
  t.after(() => {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    shell.kill('SIGKILL');
    rmSync(temporary, { recursive: true, force: true });
  });
  await waitForFile(status);
  assert.equal(readFileSync(status, 'utf8').trim(), '0');
  const output = readFileSync(log, 'utf8');
  assert.match(output, /controlled-stdout/);
  assert.match(output, /controlled-stderr/);
});

test('stop rejects a reused PID whose recorded identity differs', (t) => {
  const { root } = prepare(t);
  const child = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  if (!child.pid) throw new Error('Controlled process did not start.');
  const pid = child.pid;
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  });
  writeFileSync(join(root, 'prod/run/server.pid'), `${pid}|previous-incarnation|${pid}\n`);
  writeFileSync(join(root, 'prod/run/server.runner.pid'), `${pid}|previous-incarnation|${pid}\n`);
  execFileSync('bash', [
    '-c',
    '. "$1"; terminate_role "$2" server',
    '_',
    join(root, 'scripts/common.sh'),
    join(root, 'prod'),
  ]);
  assert.doesNotThrow(() => process.kill(pid, 0));
});

test('official Caddy 2.10.2 validates the shipped Caddyfile', (t) => {
  const caddy = process.env.KAIROS_CADDY_BIN;
  if (!caddy) {
    t.skip('Set KAIROS_CADDY_BIN to an official Caddy 2.10.2 executable.');
    return;
  }
  assert.match(execFileSync(caddy, ['version'], { encoding: 'utf8' }), /^v2\.10\.2 /);
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-caddy-validate-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  mkdirSync(join(temporary, 'gui'));
  mkdirSync(join(temporary, 'config'), { recursive: true });
  mkdirSync(join(temporary, 'data'), { recursive: true });
  execFileSync(
    caddy,
    ['validate', '--config', join(repository, 'deploy/caddy/Caddyfile'), '--adapter', 'caddyfile'],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: temporary,
        XDG_CONFIG_HOME: join(temporary, 'config'),
        XDG_DATA_HOME: join(temporary, 'data'),
        KAIROS_CADDY_PORT: '14318',
        KAIROS_SERVER_PORT: '4318',
        KAIROS_GUI_ROOT: join(temporary, 'gui'),
      },
    },
  );
});

test('runtime layout initializes and immutable installation rejects replacement', (t) => {
  const { root, path } = prepare(t);
  const version = '1'.repeat(40);
  makeRelease(root, version);
  run(root, ['install', join(root, 'incoming', version)], { path });
  assert.ok(existsSync(join(root, 'releases', version, 'release.json')));
  makeRelease(root, version);
  assert.throws(
    () => run(root, ['install', join(root, 'incoming', version)], { path }),
    /Refusing to overwrite installed release/,
  );
  assert.ok(existsSync(join(root, 'releases', version, 'SHA256SUMS')));
});

test('release backs up and migrates, rollback checks schema and switches independent workspaces', (t) => {
  const { root, path } = prepare(t);
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);
  makeRelease(root, first);
  run(root, ['install', join(root, 'incoming', first)], { path });
  run(root, ['release', 'prod', first, '--confirm-active-tasks-drained'], { path });
  assert.equal(readlinkSync(join(root, 'prod/current')), join(root, 'releases', first));
  writeFileSync(join(root, 'prod/data/kairos.sqlite'), 'controlled database');
  makeRelease(root, second);
  run(root, ['install', join(root, 'incoming', second)], { path });
  assert.throws(() => run(root, ['release', 'prod', second], { path }), /Confirm in the GUI/);
  run(root, ['release', 'prod', second, '--confirm-active-tasks-drained'], {
    path,
    migrationStatus: 'migration_required',
  });
  assert.equal(readlinkSync(join(root, 'prod/current')), join(root, 'releases', second));
  assert.match(readFileSync(join(root, 'prod/workspace/AGENTS.md'), 'utf8'), /workspace 2{40}/);
  assert.match(readFileSync(join(root, 'migration.log'), 'utf8'), /migrated/);
  assert.throws(
    () =>
      run(root, ['rollback', 'prod', first, '--confirm-active-tasks-drained'], {
        path,
        migrationStatus: 'migration_required',
      }),
    /not schema-compatible/,
  );
  assert.equal(readlinkSync(join(root, 'prod/current')), join(root, 'releases', second));
  run(root, ['rollback', 'prod', first, '--confirm-active-tasks-drained'], { path });
  assert.equal(readlinkSync(join(root, 'prod/current')), join(root, 'releases', first));
  assert.match(readFileSync(join(root, 'prod/workspace/AGENTS.md'), 'utf8'), /workspace 1{40}/);
  const backups = readdirSync(join(root, 'backups/prod'));
  assert.ok(backups.length >= 4);
  const restore = backups.find((directory) =>
    existsSync(join(root, 'backups/prod', directory, 'data/kairos.sqlite')),
  );
  assert.ok(restore);
  const restoreArgs = [
    'restore',
    'prod',
    second,
    join(root, 'backups/prod', restore),
    '--confirm-active-tasks-drained',
    '--confirm-restore',
  ];
  writeFileSync(join(root, 'prod/data/kairos.sqlite'), 'current-before-failed-restore');
  assert.throws(
    () => run(root, restoreArgs, { path, failRestoreCopy: true }),
    /controlled restore copy failure/,
  );
  assert.equal(readlinkSync(join(root, 'prod/current')), join(root, 'releases', first));
  assert.equal(
    readFileSync(join(root, 'prod/data/kairos.sqlite'), 'utf8'),
    'current-before-failed-restore',
  );
  run(root, restoreArgs, { path });
  assert.equal(readlinkSync(join(root, 'prod/current')), join(root, 'releases', second));
  assert.equal(readFileSync(join(root, 'prod/data/kairos.sqlite'), 'utf8'), 'controlled database');
  run(root, ['stop', 'prod', '--confirm-active-tasks-drained'], { path });
});
