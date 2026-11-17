import { chmodSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../scripts/swarm.mjs", import.meta.url));
export const SHIMS = fileURLToPath(new URL("../shims", import.meta.url));

// POSIX shim needs the exec bit; harmless no-op on Windows.
try { chmodSync(join(SHIMS, "claude"), 0o755); } catch { /* windows */ }
try { chmodSync(join(SHIMS, "codex"), 0o755); } catch { /* windows */ }

// The engine's memory gates read the HOST's free memory, so on a small VM (a 4 GB
// WSL distro) leaves park and a fixture's run.log grows rows the row never asked for.
// 0 is the documented "disabled" sentinel for both floors. Pinned here — the one
// place a CLI child's config is built — so every engine test inherits it; a row that
// exercises the gate overrides it through `config`.
const ENGINE_FLOORS_OFF = { minFreeMemMb: 0, valveFreeMemMb: 0 };

// Writes a throwaway config carrying `quotaPreflight` and any row-specific `config`
// unless the caller pinned SWARM_CONFIG itself. Returns the dir so the caller can
// remove it when the child exits.
function configOverlay(env, quotaPreflight, config) {
  const childEnv = { ...env };
  if (childEnv.SWARM_CONFIG !== undefined) return { configDir: undefined, childEnv };
  const configDir = mkdtempSync(join(tmpdir(), "swarm-cli-config-"));
  const configPath = join(configDir, "config.json");
  const sourcePath = childEnv.SWARM_HOME && join(childEnv.SWARM_HOME, "config.json");
  const source = sourcePath && existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf8")) : {};
  writeFileSync(configPath, JSON.stringify({ ...ENGINE_FLOORS_OFF, ...source, ...config, quotaPreflight }), "utf8");
  childEnv.SWARM_CONFIG = configPath;
  return { configDir, childEnv };
}

const CLI_TIMEOUT_MS = 60000;

// The env a CLI call runs under, spawned or in-process — one definition, so the
// two paths cannot drift apart.
function runEnv(childEnv) {
  return {
    ...process.env,
    PATH: SHIMS + delimiter + process.env.PATH,
    Path: SHIMS + delimiter + (process.env.Path || process.env.PATH),
    // Pin the append-only stdout contract: the suite may itself be running
    // inside a repainting harness, whose CLAUDECODE would otherwise leak in.
    SWARM_REPAINT: "0",
    // The child reads ~/.claude for Claude's model catalog; an unpinned home would
    // read the developer's real machine and pass only where that dir is absent.
    ...(childEnv.SWARM_HOME ? { HOME: childEnv.SWARM_HOME, USERPROFILE: childEnv.SWARM_HOME } : {}),
    ...childEnv,
  };
}

export function runCli(args, { cwd, env = {}, quotaPreflight = false, config = {} } = {}) {
  const { configDir, childEnv } = configOverlay(env, quotaPreflight, config);
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      env: runEnv(childEnv),
    });
  } finally {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  }
}

// Async variant for tests that host a stub HTTP server in THIS process:
// spawnSync would block the event loop and the server could never respond.
export function runCliAsync(args, { cwd, env = {}, quotaPreflight = false, config = {} } = {}) {
  const { configDir, childEnv } = configOverlay(env, quotaPreflight, config);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      windowsHide: true,
      env: runEnv(childEnv),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}

// The same call with no spawn: `main` runs here, its sink captured. Returns the
// shape runCli returns. ~0.9 s per spawn is what this exists to remove.
//
// One at a time: the sink, cwd and env it swaps are process-wide, so overlapping
// calls would cross-contaminate. `resetForTests` after every call keeps the
// module memos from leaking into the next one.
let inProcessQueue = Promise.resolve();

const RESET_MODULES = [
  "../../src/rate-card.mjs",
  "../../src/taken.mjs",
  "../../src/serve/logos.mjs",
  "../../src/scheduler/loop-stall.mjs",
];

async function resetModuleCaches() {
  for (const spec of RESET_MODULES) (await import(spec)).resetForTests();
}

const MISSING = Symbol("missing");

// The env the call swapped in, and the restore. Only touched keys are restored,
// so a caller's own env survives untouched.
function applyEnv(target) {
  const changed = [];
  for (const [key, value] of Object.entries(target)) {
    if (process.env[key] === value) continue;
    changed.push([key, Object.hasOwn(process.env, key) ? process.env[key] : MISSING]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, prev] of changed) {
      if (prev === MISSING) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

function capture() {
  const buf = { text: "" };
  // isTTY left undefined: a captured sink is a pipe, which is what a spawned
  // call's stdout is too — so colour and repaint resolve identically.
  buf.sink = { write: (s) => { buf.text += s; return true; } };
  return buf;
}

async function callInProcess(args, { cwd, env, quotaPreflight, config }) {
  const { configDir, childEnv } = configOverlay(env, quotaPreflight, config);
  const out = capture();
  const err = capture();
  const restoreEnv = applyEnv(runEnv(childEnv));
  const cwdBefore = process.cwd();
  try {
    if (cwd) process.chdir(cwd);
    const { main } = await import("../../scripts/swarm.mjs");
    let timer;
    try {
      const status = await Promise.race([
        main(args, { stdout: out.sink, stderr: err.sink }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`runCliInProcess timed out after ${CLI_TIMEOUT_MS} ms: ${args.join(" ")}`)), CLI_TIMEOUT_MS);
        }),
      ]);
      return { status, stdout: out.text, stderr: err.text };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    process.chdir(cwdBefore);
    restoreEnv();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    await resetModuleCaches();
  }
}

export function runCliInProcess(args, opts = {}) {
  const run = inProcessQueue.then(() => callInProcess(args, opts));
  inProcessQueue = run.then(() => {}, () => {});
  return run;
}

// The dispatch gate refuses `run` on a manifest whose exact bytes were never
// validated, so every run-path row validates first — same ref, same --args. A
// refusal here is a broken fixture, not the row's subject: throw rather than let
// the row assert against the gate's own message.
export function runValidated(args, opts = {}) {
  const call = opts.inProcess ? runCliInProcess : opts.async ? runCliAsync : runCli;
  const proceed = (v, ref) => {
    if (v.status !== 0) throw new Error(`runValidated: validate refused ${ref} (${v.status}):\n${v.stdout}${v.stderr}`);
    return call(args, opts);
  };
  const ref = args[1];
  if (!ref || ref.startsWith("--")) return call(args, opts);
  const i = args.indexOf("--args");
  const refArgs = ["validate", ref, ...(i < 0 ? [] : ["--args", args[i + 1]])];
  const v = call(refArgs, opts);
  // Async runners can only be sequenced through the promise; a spawn is already done.
  return opts.inProcess || opts.async ? v.then((r) => proceed(r, ref)) : proceed(v, ref);
}
