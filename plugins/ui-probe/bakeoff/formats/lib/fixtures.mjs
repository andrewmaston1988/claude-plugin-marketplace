// Starts every fixture a task needs and stops them again. Only processes this
// process spawned are ever killed, and only by PID.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from '../fixtures/servers.mjs';
import { uiaText } from './probes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_FIXTURE = path.join(HERE, '..', 'fixtures', 'windows-fixture.ps1');
const PROBE_CLI = path.join(HERE, '..', 'fixtures', 'probe-cli.mjs');

export { PROBE_CLI };

async function waitFor(predicate, { timeoutMs = 20000, everyMs = 300, label = 'fixture' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`${label} not ready within ${timeoutMs} ms${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function startWindowsFixture(value) {
  // windowsHide must stay false: CREATE_NO_WINDOW makes the first WinForms window
  // start hidden, so UIA never sees it (measured, 2026-11-13).
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_FIXTURE, '-Value', value], {
    stdio: 'ignore', windowsHide: false,
  });
  const pid = child.pid;
  await waitFor(async () => (await uiaText('ui-probe-fixture', 'ValueBox')) === value, {
    label: `windows fixture (pid ${pid})`, timeoutMs: 25000,
  });
  return {
    pid,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('close', () => resolve());
      try { child.kill(); } catch { resolve(); }
    }),
  };
}

export async function startAll({ need = ['web', 'http', 'tcp', 'windows'] } = {}) {
  const want = new Set(need);
  const stop = [];
  let servers = null;
  if (want.has('web') || want.has('http') || want.has('tcp')) {
    servers = await startFixtures();
    stop.push(() => servers.close());
  }
  let windows = null;
  if (want.has('windows')) {
    windows = await startWindowsFixture('fixture-value-42');
    stop.push(() => windows.stop());
  }
  return {
    servers,
    windows,
    async close() {
      for (const fn of stop.reverse()) await Promise.resolve(fn()).catch(() => {});
    },
  };
}
