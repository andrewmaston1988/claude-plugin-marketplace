// Thin adapters over each Windows UIA contender. Every adapter takes the same
// normalized command ({op, title, name, ...}) and returns the same result shape, so the
// harness — not the adapter — owns tasks, timings, repeats and verification.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PS51 = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const UIA_SCRIPT = path.join(HERE, 'uia-script.ps1');
export const UIA_WORKER = path.join(HERE, 'uia-worker.ps1');
export const PYWINAUTO_CLI = path.join(HERE, 'pywinauto_cli.py');
export const FLAUI_EXE = path.join(HERE, 'flaui', 'bin', 'Release', 'net8.0-windows', 'flaui-helper.exe');

function ms(t0) {
  return Math.round(performance.now() - t0);
}

/** Serialises the tool's own stdout so output-size rows compare like with like. */
function lastJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

class WarmChannel {
  constructor(label, bin, argv) {
    this.label = label;
    this.bin = bin;
    this.argv = argv;
    this.lines = [];
    this.waiters = [];
    this.stderr = '';
  }

  async start() {
    this.proc = spawn(this.bin, this.argv, { windowsHide: true });
    this.proc.stderr.on('data', (d) => {
      this.stderr += d.toString();
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    });
    this.proc.on('exit', (code) => {
      for (const w of this.waiters.splice(0)) w.resolve(null);
      this.exited = code;
    });
    const hello = await this.next(30000);
    if (hello === null) throw new Error(`${this.label} failed to start: ${this.stderr}`);
    return hello;
  }

  next(timeoutMs = 120000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }

  async request(cmd) {
    this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    const line = await this.next();
    if (line === null) throw new Error(`${this.label} closed without a reply: ${this.stderr}`);
    return JSON.parse(line);
  }

  stop() {
    try {
      this.proc.stdin.write('{"op":"quit"}\n');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
    }, 500).unref?.();
  }
}

function parseStdout(stdout) {
  const whole = stdout.trim();
  // winapp pretty-prints its JSON, so a line-oriented parse finds nothing; try the whole
  // buffer first, then fall back to one-object-per-line / trailing-line output.
  if (whole.startsWith('{')) {
    try {
      return JSON.parse(whole);
    } catch {
      /* multi-line output with trailing noise */
    }
    const first = whole.indexOf('{');
    const last = whole.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(whole.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return lastJsonLine(stdout);
}

/** Spawn-per-call adapter over uia-script.ps1. */
class PowerShellCold {
  constructor() {
    this.id = 'ps-cold';
    this.label = 'powershell.exe per call (System.Windows.Automation)';
    this.mode = 'per-call';
    this.notes = 'Spawn, Add-Type, find and act in one process. Cold and warm both pay process start.';
  }
  async start() {}
  async stop() {}
  async call(cmd, run) {
    return run(PS51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_SCRIPT, '-CommandJson', JSON.stringify(cmd)]);
  }
}

/** Kept-warm PowerShell UIA worker (stdin JSON lines). */
class PowerShellWarm {
  constructor() {
    this.id = 'ps-warm';
    this.label = 'kept-warm powershell.exe UIA worker';
    this.mode = 'warm';
    this.notes = 'Long-lived process; window elements cached by title. Cold = first call after start.';
    this.channel = null;
  }
  async start() {
    this.channel = new WarmChannel('ps-warm', PS51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_WORKER]);
    await this.channel.start();
  }
  async stop() {
    this.channel?.stop();
    this.channel = null;
  }
  async call(cmd) {
    const t0 = performance.now();
    const reply = await this.channel.request(cmd);
    reply.__wall_ms = ms(t0);
    return reply;
  }
}

/** Spawn-per-call pywinauto. */
class PywinautoCold {
  constructor() {
    this.id = 'pywinauto-call';
    this.label = 'pywinauto per call (uia backend)';
    this.mode = 'per-call';
    this.notes = 'python + pywinauto import and desktop search on every call.';
  }
  async start() {}
  async stop() {}
  async call(cmd, run) {
    return run('python', [PYWINAUTO_CLI, JSON.stringify(cmd)]);
  }
}

/** Kept-warm pywinauto process. */
class PywinautoWarm {
  constructor() {
    this.id = 'pywinauto-warm';
    this.label = 'kept-warm pywinauto worker';
    this.mode = 'warm';
    this.notes = 'python pywinauto_cli.py --serve; cold = first call after import.';
    this.channel = null;
  }
  async start() {
    this.channel = new WarmChannel('pywinauto-warm', 'python', [PYWINAUTO_CLI, '--serve']);
    await this.channel.start();
  }
  async stop() {
    this.channel?.stop();
    this.channel = null;
  }
  async call(cmd) {
    const t0 = performance.now();
    const reply = await this.channel.request(cmd);
    reply.__wall_ms = ms(t0);
    return reply;
  }
}

/** FlaUI UIA3 helper: dotnet process, serve mode (cold = one-shot process with argv). */
class FlauiWarm {
  constructor() {
    this.id = 'flaui-warm';
    this.label = 'FlaUI 4.0 UIA3 helper (dotnet, long-running)';
    this.mode = 'warm';
    this.notes = 'Built with .NET SDK 8.0.428 + FlaUI 4.0.0. Cold = first call after process start.';
    this.channel = null;
  }
  async start() {
    this.channel = new WarmChannel('flaui-warm', FLAUI_EXE, []);
    await this.channel.start();
  }
  async stop() {
    this.channel?.stop();
    this.channel = null;
  }
  async call(cmd) {
    const t0 = performance.now();
    const reply = await this.channel.request(cmd);
    reply.__wall_ms = ms(t0);
    return reply;
  }
}

class FlauiCold {
  constructor() {
    this.id = 'flaui-cold';
    this.label = 'FlaUI 4.0 UIA3 helper, one process per call';
    this.mode = 'per-call';
    this.notes = 'Same helper invoked with the command as argv; pays .NET process start per call.';
  }
  async start() {}
  async stop() {}
  async call(cmd, run) {
    return run(FLAUI_EXE, [JSON.stringify(cmd)]);
  }
}

/** winapp ui 0.8.0 — CLI only, one process per call, --json output. */
class WinappCli {
  constructor() {
    this.id = 'winapp';
    this.label = 'winapp ui 0.8.0 (CLI)';
    this.mode = 'per-call';
    this.notes = 'No CacheRequest and no event subscription surface; tree via inspect --json.';
  }
  async start() {}
  async stop() {}

  argvFor(cmd) {
    const app = cmd.title;
    switch (cmd.op) {
      case 'find':
        return ['ui', 'status', '-a', app, '--json'];
      case 'tree':
      case 'tree_uncached':
        return ['ui', 'inspect', '-a', app, '--json', '--depth', '40'];
      case 'tree_cached':
        return null; // unsupported
      case 'get':
        return ['ui', 'get-value', cmd.name, '-a', app, '--json'];
      case 'click':
        return ['ui', 'invoke', cmd.name, '--type', cmd.controlType ?? 'Button', '-a', app, '--json'];
      case 'list':
        return ['ui', 'search', '--type', 'ListItem', '-a', app, '--max', '20', '--json'];
      default:
        return null;
    }
  }

  async call(cmd, run) {
    const argv = this.argvFor(cmd);
    if (!argv) {
      return { ok: false, op: cmd.op, error: 'unsupported by winapp ui 0.8.0', unsupported: true };
    }
    return run('winapp', argv);
  }
}

/** Runs one process and normalises {ok, value, count, items, bytes, wall_ms}. */
export async function runProcess(bin, argv) {
  const t0 = performance.now();
  const child = spawn(bin, argv, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(-1);
    }, 120000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const wall = ms(t0);
  const json = parseStdout(stdout);
  const base = {
    __wall_ms: wall,
    __bytes: Buffer.byteLength(stdout, 'utf8'),
    __exit: code,
    __stderr: stderr.trim().slice(0, 500),
    __raw: stdout.slice(0, 2000),
  };
  if (!json) {
    return { ok: false, op: 'error', error: stderr.trim() || `exit ${code} with no JSON`, ...base };
  }
  return { ...json, ...base };
}

export function makeContender(id) {
  switch (id) {
    case 'ps-cold':
      return new PowerShellCold();
    case 'ps-warm':
      return new PowerShellWarm();
    case 'pywinauto-call':
      return new PywinautoCold();
    case 'pywinauto-warm':
      return new PywinautoWarm();
    case 'flaui-warm':
      return new FlauiWarm();
    case 'flaui-cold':
      return new FlauiCold();
    case 'winapp':
      return new WinappCli();
    default:
      throw new Error(`unknown contender: ${id}`);
  }
}

export const CONTENDERS = [
  'winapp',
  'ps-cold',
  'ps-warm',
  'pywinauto-call',
  'pywinauto-warm',
  'flaui-cold',
  'flaui-warm',
];
