import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] !== '--' || args.length < 2) {
  throw new Error('Usage: node process-supervisor.mjs -- COMMAND [ARG...]');
}

const command = args.slice(1);
let completion;

function groupMembers() {
  const inspection = spawnSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  if (inspection.status !== 0) throw new Error('Unable to inspect the supervised process group.');
  return inspection.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, group, state]) => {
      const numericPid = Number(pid);
      return (
        Number(group) === process.pid &&
        numericPid !== process.pid &&
        numericPid !== inspection.pid &&
        !state?.startsWith('Z')
      );
    })
    .map(([pid]) => Number(pid));
}

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function waitForGroup(status) {
  return (async () => {
    while (groupMembers().length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.exitCode = status;
  })();
}

function finish(status, operatorStop = false) {
  if (completion) return completion;
  if (operatorStop) {
    completion = waitForGroup(status).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    return completion;
  }
  completion = (async () => {
    if (groupMembers().length === 0) {
      process.exitCode = status;
      return;
    }
    signalGroup('SIGTERM');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (groupMembers().length === 0) {
        process.exitCode = status;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (groupMembers().length === 0) process.exitCode = status;
    else signalGroup('SIGKILL');
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  return completion;
}

const child = spawn(command[0], command.slice(1), {
  detached: false,
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.once('error', () => finish(127));
child.once('exit', (code, signal) => {
  const status = code ?? (signal ? 128 : 1);
  finish(status);
});
process.on('SIGTERM', () => finish(143, true));
process.on('SIGINT', () => finish(130, true));
