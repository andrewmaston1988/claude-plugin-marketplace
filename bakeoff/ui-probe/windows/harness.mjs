// Shared harness for the Windows lane (RQ4/RQ5): fixtures, task definitions, timing,
// repeats, verification and the output schema. Every contender runs these exact tasks.
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERE, PS51, runProcess } from './adapters.mjs';

export const REPEATS = 10;
export const WARMUPS = 2;
export const FIXTURE_SCRIPT = path.join(HERE, '..', 'fixtures', 'windows_fixtures.ps1');

export const TITLES = {
  WinForms: 'ui-probe fixture (WinForms)',
  Wpf: 'ui-probe fixture (WPF)',
  OwnerDrawn: 'ui-probe fixture (OwnerDrawn)',
};

export const FIXTURES = {
  WinForms: {
    title: TITLES.WinForms,
    textName: 'Fixture Text',
    textValue: 'fixture-value-42',
    saveName: 'Save',
    checkName: 'Enable sync',
    listName: 'FixtureListBox',
  },
  Wpf: {
    title: TITLES.Wpf,
    textName: 'Fixture Text',
    textValue: 'fixture-value-42',
    saveName: 'Save',
    checkName: 'Enable sync',
    listName: 'FixtureListBox',
  },
  // The painted strings are the point: a UIA lookup for one must fail, since nothing in
  // the control tree carries them.
  OwnerDrawn: { title: TITLES.OwnerDrawn, textName: 'Alpha 17', textValue: 'Alpha 17' },
  Notepad: { title: null, textName: 'Text editor', textValue: 'fixture-value-42' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchFixture(kind, tmpDir, logFile) {
  const ready = path.join(tmpDir, `${kind}.ready`);
  fs.rmSync(ready, { force: true });
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE_SCRIPT, '-Kind', kind, '-ReadyFile', ready];
  if (logFile) argv.push('-LogFile', logFile);
  // windowsHide would make the hosted WinForms/WPF window start hidden (SW_HIDE is
  // inherited by the first ShowWindow), so fixtures launch with a visible console.
  const child = spawn(PS51, argv, { stdio: 'ignore' });
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(100);
  if (!fs.existsSync(ready)) {
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(`fixture ${kind} did not report ready`);
  }
  const pid = Number(fs.readFileSync(ready, 'utf8').trim());
  await sleep(150); // first paint before any automation touches it
  // Carry the task metadata (textName/textValue/...) so cmdFor can build the same command
  // for every fixture; the launched handle alone only knows its title and pid.
  return { ...FIXTURES[kind], kind, pid, title: TITLES[kind], child };
}

export async function launchNotepad(tmpDir) {
  const file = path.join(tmpDir, 'ui-probe-notepad.txt');
  fs.writeFileSync(file, 'fixture-value-42\r\nsecond line\r\n', 'utf8');
  const child = spawn('notepad.exe', [file], { stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  let found = null;
  while (!found && Date.now() < deadline) {
    await sleep(300);
    const r = spawnSync(PS51, ['-NoProfile', '-Command',
      "$p = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*ui-probe-notepad*' } | Select-Object -First 1; if ($p) { \"$($p.Id)`t$($p.MainWindowTitle)\" }"],
    { encoding: 'utf8', windowsHide: true });
    const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (line) {
      const [pid, ...rest] = line.split('\t');
      found = { ...FIXTURES.Notepad, kind: 'Notepad', pid: Number(pid), title: rest.join('\t'), child };
    }
  }
  if (!found) {
    try { child.kill(); } catch { /* ignore */ }
    throw new Error('notepad window did not appear');
  }
  return found;
}

export function killFixture(fixture) {
  if (!fixture) return;
  try {
    process.kill(fixture.pid);
  } catch {
    /* already gone */
  }
  try {
    fixture.child?.kill();
  } catch {
    /* already gone */
  }
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(v * 10) / 10;
}

export function summarize(samples) {
  return {
    n: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples,
  };
}

/** winapp's inspect nests children; count them the same way the other adapters do. */
function countWinappElements(elements) {
  let n = 0;
  for (const el of elements ?? []) {
    n += 1;
    n += countWinappElements(el.children);
  }
  return n;
}

export function normalizeReply(contenderId, op, reply) {
  if (contenderId !== 'winapp') return reply;
  switch (op) {
    case 'find':
      return {
        ...reply,
        ok: reply.ok !== false && reply.processId !== undefined,
        pid: reply.processId,
        name: reply.windowTitle,
      };
    case 'tree':
    case 'tree_uncached':
      return {
        ...reply,
        ok: reply.ok !== false,
        count: reply.windows?.reduce((acc, w) => acc + countWinappElements(w.elements), 0) ?? 0,
      };
    case 'tree_cached':
      return { ...reply, ok: false, unsupported: true, error: 'winapp ui has no CacheRequest' };
    case 'get':
      return { ...reply, ok: reply.ok !== false && reply.text !== undefined, value: reply.text };
    case 'click':
      return { ...reply, ok: reply.ok !== false && reply.performedAction !== undefined };
    case 'list':
      return {
        ...reply,
        ok: reply.ok !== false,
        items: (reply.matches ?? []).map((m) => m.name),
        count: (reply.matches ?? []).length,
      };
    default:
      return reply;
  }
}

let processRun = null;

/** One measured call. `mode` decides whether start/stop counts as part of the sample. */
export async function invoke(adapter, cmd) {
  const runner = (bin, argv) => runProcess(bin, argv);
  const t0 = performance.now();
  const reply = await adapter.call(cmd, runner);
  const wall = msSince(t0);
  const normalized = normalizeReply(adapter.id, cmd.op, reply);
  normalized.__wall_ms = reply.__wall_ms ?? wall;
  normalized.__bytes = reply.__bytes ?? Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  return normalized;
}

export function msSince(t0) {
  return Math.round(performance.now() - t0);
}

export function makeTmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ui-probe-${tag}-`));
}

export function countLogLines(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function cleanTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export { processRun };
