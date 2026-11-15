// The plugin test runner: one owner for how a plugin's tests are run. Flags are
// in USAGE below; tiers, exit codes and test-writing rules are in TESTING.md.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { SUITES } from "./test-suites.mjs";
import { ChangedSetError, changedSet, resolveBase } from "./test-lib/changed.mjs";
import { expandRun, select, wholeEntries } from "./test-lib/select.mjs";

const USAGE = `usage: node scripts/test.mjs [--all] [--suite <name>] [--against <ref>] [--list] [--wsl]`;

// --- Install ---------------------------------------------------------------

/** `npm ci` once per lockfile hash. The record lives inside `node_modules`,
 *  which the WSL mirror's rsync excludes, so a `--delete` sync leaves it. */
export function installIfNeeded({
  cwd,
  install,
  _fs = nodeFs,
  _spawnSync = spawnSync,
  _platform = process.platform,
} = {}) {
  const lockfile = join(cwd, "package-lock.json");
  if (!_fs.existsSync(lockfile)) return { installed: false };
  const hash = createHash("sha256").update(_fs.readFileSync(lockfile)).digest("hex");
  const record = join(cwd, "node_modules", ".test-install-hash");
  if (_fs.existsSync(record)) {
    let recorded = "";
    try {
      recorded = String(_fs.readFileSync(record, "utf8")).trim();
    } catch {
      recorded = "";
    }
    if (recorded === hash) return { installed: false };
  }
  const [command, ...args] = install;
  const result = _spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: _platform === "win32", // npm is npm.cmd here, which spawn cannot exec directly
  });
  if (!result || result.error || result.status !== 0) {
    return { installed: false, error: `install failed (${install.join(" ")})` };
  }
  _fs.mkdirSync(join(cwd, "node_modules"), { recursive: true });
  _fs.writeFileSync(record, hash);
  return { installed: true };
}

// --- Running ---------------------------------------------------------------

/** A timed-out run is killed as a TREE: the test process spawns children of its
 *  own, and killing only the parent leaves them holding the pipe. */
export function killTree(pid, { platform = process.platform, _spawnSync = spawnSync, _kill = process.kill } = {}) {
  if (!pid) return;
  if (platform === "win32") {
    _spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    _kill(-pid, "SIGKILL"); // the spawn's own process group
  } catch {
    // Already gone: nothing to kill, and nothing worth reporting.
  }
}

export function summaryLine(result) {
  const detail = result.reason ? ` -- ${result.reason}` : "";
  return `[test] ${result.label}: ${result.status.toUpperCase()}${detail} in ${(result.durationMs / 1000).toFixed(1)}s`;
}

async function runOne({ suite, run, files, repoRoot, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now }) {
  const cwdAbs = join(repoRoot, run.cwd);
  const label = `${suite.name}${run.label ? `[${run.label}]` : ""}`;
  const started = _now();

  if (run.install) {
    const installed = installIfNeeded({ cwd: cwdAbs, install: run.install, _fs, _spawnSync, _platform });
    if (installed.error) {
      return { suite: suite.name, label, ok: false, status: "fail", reason: installed.error, files, durationMs: _now() - started };
    }
    if (installed.installed) _log(`[test] ${label}: installed (lockfile changed)`);
  }

  const args = [];
  if (run.envFile) args.push(`--env-file=${run.envFile}`);
  const base = run.cwd === "." || run.cwd === "" ? "." : run.cwd;
  args.push("--test", ...files.map((file) => posix.relative(base, file)));

  let child;
  try {
    child = _spawn(process.execPath, args, {
      cwd: cwdAbs,
      env: { ...process.env, ...(run.env || {}) },
      stdio: "inherit",
      detached: _platform !== "win32", // its own process group, so killTree can reach it
      windowsHide: true,
    });
  } catch (err) {
    return { suite: suite.name, label, ok: false, status: "fail", reason: err.message, files, durationMs: _now() - started };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ suite: suite.name, label, files, durationMs: _now() - started, ...result });
    };
    timer = setTimeout(() => {
      _killTree(child.pid, { platform: _platform, _spawnSync });
      finish({ ok: false, status: "timeout", reason: `no exit within ${run.timeoutMs}ms`, exitCode: null });
    }, run.timeoutMs);
    child.once("close", (code) => {
      if (settled) return;
      finish(code === 0
        ? { ok: true, status: "pass", exitCode: 0 }
        : { ok: false, status: "fail", exitCode: code, reason: `exit ${code}` });
    });
    child.once("error", (err) => finish({ ok: false, status: "fail", reason: err.message, exitCode: null }));
  });
}

/** Run every suite (all its runs) or only the selected files.
 *
 *  `selected` is a set of `<suite>\0<file>` keys; null means run every suite
 *  whole. A run with nothing selected is skipped in diff mode -- it is not a
 *  failure -- but a whole-suite run whose globs match no file always fails. */
export async function runSuites(suites, {
  selected = null,
  repoRoot,
  _spawn = spawn,
  _spawnSync = spawnSync,
  _platform = process.platform,
  _killTree = killTree,
  _fs = nodeFs,
  _log = () => {},
  _now = Date.now,
  _readdirSync = nodeFs.readdirSync,
} = {}) {
  const results = [];
  for (const suite of suites) {
    for (const run of suite.runs) {
      const expanded = expandRun(run, { repoRoot, _readdirSync });
      const files = selected
        ? expanded.filter((file) => selected.has(`${suite.name}\0${file}`))
        : expanded;
      const label = `${suite.name}${run.label ? `[${run.label}]` : ""}`;
      if (files.length === 0) {
        if (selected) {
          _log(`[test] ${label}: skipped (nothing selected)`);
          continue;
        }
        results.push({
          suite: suite.name,
          label,
          ok: false,
          status: "no-files",
          reason: `no file matched ${run.globs.join(" ")}`,
          files,
          durationMs: 0,
        });
        continue;
      }
      results.push(await runOne({ suite, run, files, repoRoot, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now }));
    }
  }
  return results;
}

// --- CLI -------------------------------------------------------------------

function usage(message, _err) {
  _err(`[test] ${message}`);
  _err(USAGE);
  return 2;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const {
    cwd = process.cwd(),
    _spawn = spawn,
    _spawnSync = spawnSync,
    _platform = process.platform,
    _killTree = killTree,
    _fs = nodeFs,
    _now = Date.now,
    _suites = SUITES,
    _log = (line) => process.stdout.write(`${line}\n`),
    _err = (line) => process.stderr.write(`${line}\n`),
  } = options;

  let suiteName = null;
  let all = false;
  let listOnly = false;
  let wsl = false;
  let against = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") all = true;
    else if (arg === "--list") listOnly = true;
    else if (arg === "--wsl") wsl = true;
    else if (arg === "--help" || arg === "-h") {
      _log(USAGE);
      return 0;
    } else if (arg === "--suite" || arg.startsWith("--suite=")) {
      suiteName = arg === "--suite" ? argv[++i] : arg.slice("--suite=".length);
      if (!suiteName) return usage("--suite needs a suite name", _err);
    } else if (arg === "--against" || arg.startsWith("--against=")) {
      against = arg === "--against" ? argv[++i] : arg.slice("--against=".length);
      if (!against) return usage("--against needs a ref", _err);
    } else {
      return usage(`unknown argument ${arg}`, _err);
    }
  }
  if (all && suiteName) return usage("--suite and --all are exclusive", _err);
  if (wsl) {
    // WSL mode runs the whole regression by design; a selection flag alongside
    // it would be read as narrowing that run, so refuse rather than ignore it.
    const flags = [
      ["--list", listOnly],
      ["--suite", Boolean(suiteName)],
      ["--against", Boolean(against)],
      ["--all", all],
    ];
    const conflict = flags.find(([, given]) => given);
    if (conflict) return usage(`--wsl cannot be combined with ${conflict[0]}`, _err);
  }

  let repoRoot;
  try {
    const r = _spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    if (!r || r.error || r.status !== 0) throw new Error((r && r.stderr) || "not a git repository");
    repoRoot = r.stdout.trim();
  } catch (err) {
    return usage(`cannot read the repository root: ${err.message}`, _err);
  }

  if (wsl) {
    let runWsl;
    try {
      ({ runWsl } = await import("./test-lib/wsl.mjs"));
    } catch (err) {
      return usage(`--wsl needs scripts/test-lib/wsl.mjs: ${err.message}`, _err);
    }
    return await runWsl({
      repoRoot,
      command: ["node", "scripts/test.mjs", "--all"],
      _spawnSync,
      _fs,
      log: (line) => _log(line),
    });
  }

  let chosen;
  if (suiteName) {
    // Against the injected list only: a suite passed in by a test must win over
    // a built-in of the same name, or the test cannot exercise its own registry.
    const suite = _suites.find((s) => s.name === suiteName);
    if (!suite) return usage(`unknown suite ${suiteName} (known: ${_suites.map((s) => s.name).join(", ")})`, _err);
    chosen = [suite];
  } else chosen = _suites;

  let entries;
  let selected = null;
  const whole = Boolean(all || suiteName);
  if (whole) {
    entries = wholeEntries(chosen, { repoRoot });
  } else {
    let base;
    let changed;
    try {
      base = resolveBase({ repoRoot, against, _spawnSync });
      changed = changedSet({ repoRoot, base, _spawnSync });
    } catch (err) {
      if (!(err instanceof ChangedSetError)) throw err;
      return usage(err.message, _err);
    }
    const result = select({ suites: chosen, changed, repoRoot });
    entries = result.entries;
    if (result.docsOnly) {
      _err(`[test] docs-only: ${changed.length} changed file(s) select no test; nothing to run for them`);
    }
    selected = new Set(entries.map((entry) => `${entry.suite}\0${entry.file}`));
  }

  if (listOnly) {
    for (const entry of entries) _log(`${entry.suite} ${entry.file} ${entry.why}`);
    return 0;
  }
  // An empty diff selection is a pass. An empty whole-suite expansion is not:
  // it would report success having run nothing, so it falls through to
  // `runSuites` and the no-files failure that names the glob.
  if (!whole && entries.length === 0) {
    _log("[test] nothing selected");
    return 0;
  }

  const results = await runSuites(chosen, {
    selected,
    repoRoot,
    _spawn,
    _spawnSync,
    _platform,
    _killTree,
    _fs,
    _log,
    _now,
  });
  if (results.length === 0) {
    _log("[test] nothing to run");
    return 0;
  }
  for (const result of results) _log(summaryLine(result));
  const failed = results.filter((result) => !result.ok);
  _log(`[test] ${results.length - failed.length}/${results.length} run(s) passed`);
  return failed.length === 0 ? 0 : 1;
}

// `exitCode` rather than `exit()`: stdout/stderr are async pipes on Windows and
// would be truncated mid-write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`[test] ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    },
  );
}
