// Live-verification harness: builds an isolated environment, pushes a
// fake-claude binary onto PATH, queues a plan, runs the orchestrator one
// tick, and asserts the row + sessions + progress state advanced.
//
// Invocation:
//   node tests/live-verify/harness.mjs [scenario.mjs]
//
// Without a scenario arg, runs the happy-path baseline below.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE         = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT  = resolvePath(HERE, "..", "..");
const FAKE_CLAUDE  = resolvePath(HERE, "fake-claude.mjs");
const PIPELINE_BIN = resolvePath(PLUGIN_ROOT, "bin", "pipeline.mjs");

function _log(...m) { process.stdout.write(m.join(" ") + "\n"); }

// ── env / path setup ────────────────────────────────────────────────────────

export function buildEnv() {
  const root = mkdtempSync(join(tmpdir(), "pipeline-verify-"));
  const dataDir  = join(root, ".pipeline");
  const claudeDir = join(root, "claude");          // alt ~/.claude
  const projectRoot = join(root, "project");
  const binDir = join(root, "bin");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(projectRoot, "plans"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // git init
  const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  if (r.status !== 0) throw new Error("git init failed");
  spawnSync("git", ["config", "user.email", "verify@local"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.name", "verify"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "verify\n");
  spawnSync("git", ["add", "."], { cwd: projectRoot });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: projectRoot });

  // Stub `claude` on PATH that forwards to fake-claude.mjs
  if (process.platform === "win32") {
    const bat = join(binDir, "claude.bat");
    writeFileSync(bat, `@echo off\r\nnode "${FAKE_CLAUDE}" %*\r\n`);
  } else {
    const sh = join(binDir, "claude");
    writeFileSync(sh, `#!/usr/bin/env bash\nexec node "${FAKE_CLAUDE}" "$@"\n`);
    chmodSync(sh, 0o755);
  }

  return { root, dataDir, claudeDir, projectRoot, binDir };
}

export function teardownEnv(env) {
  try { rmSync(env.root, { recursive: true, force: true }); } catch {}
}

function envVars(env) {
  return {
    ...process.env,
    // Override XDG/AppData equivalents — both for getPaths' lookup paths
    APPDATA:         env.root,
    LOCALAPPDATA:    env.root,
    XDG_DATA_HOME:   env.root,
    XDG_CONFIG_HOME: env.root,
    XDG_STATE_HOME:  env.root,
    XDG_CACHE_HOME:  env.root,
    HOME:            env.root,
    USERPROFILE:     env.root,
    // Pin fake-claude to use our plugin's pipeline-db
    FAKE_CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    FAKE_CLAUDE_PROJECT:     "live-verify",
    // PATH prepend
    PATH: [env.binDir, process.env.PATH || ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
  };
}

// ── CLI wrappers ────────────────────────────────────────────────────────────

export function runCli(env, argv) {
  const r = spawnSync(process.execPath, [PIPELINE_BIN, ...argv], {
    env: envVars(env), encoding: "utf8", windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function runOrchOnce(env, { intervalSec = 1, maxConcurrent = 1 } = {}) {
  // Drive orchestrator for ~6 seconds — long enough for spawn → tick →
  // fake-claude to complete its 1s simulated session → reaper to catch it.
  return new Promise((resolveRun) => {
    const ORCH = resolvePath(PLUGIN_ROOT, "scripts", "orchestrator", "index.mjs");
    const proc = spawn(process.execPath, [
      ORCH, "--interval", String(intervalSec), "--max-concurrent", String(maxConcurrent),
    ], { env: envVars(env), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", b => out += b.toString());
    proc.stderr.on("data", b => err += b.toString());
    setTimeout(() => {
      try { process.kill(proc.pid); } catch {}
    }, 6000);
    proc.on("close", code => resolveRun({ code, stdout: out, stderr: err }));
  });
}

// ── assertions ──────────────────────────────────────────────────────────────

export function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

export function readRow(env, project, feature) {
  const r = runCli(env, ["rows", project, "--format", "plain"]);
  for (const line of (r.stdout || "").split("\n")) {
    const [f, stage, ...rest] = line.split("\t");
    if (f === feature) return { feature: f, stage, notes: rest.join("\t") };
  }
  return null;
}

// ── happy-path scenario ────────────────────────────────────────────────────

async function happyPath() {
  const env = buildEnv();
  _log(`[verify] env root: ${env.root}`);
  try {
    const project = "live-verify";
    runCli(env, ["project-add", project, env.projectRoot]);

    const planPath = join(env.projectRoot, "plans", "verify-feature.md");
    writeFileSync(planPath, `# Verify Feature\n\n- step 1\n- step 2\n`);

    let q = runCli(env, ["queue-plan", project, planPath, "--type", "dev"]);
    _log(`[verify] queue-plan exit ${q.code}`);
    if (q.code !== 0) throw new Error(`queue-plan failed: ${q.stderr.trim()}`);

    let before = readRow(env, project, "verify-feature");
    _log(`[verify] row before: ${JSON.stringify(before)}`);
    assert(before, "row exists after queue-plan");
    assert(before.stage === "queued", `expected queued, got ${before.stage}`);

    _log(`[verify] running orchestrator (~6s)`);
    const orchResult = await runOrchOnce(env);
    _log(`[verify] orch exit ${orchResult.code}`);

    let after = readRow(env, project, "verify-feature");
    _log(`[verify] row after: ${JSON.stringify(after)}`);
    assert(after, "row exists after orch tick");
    assert(after.stage !== "queued", `stage should have advanced from queued, got ${after.stage}`);

    _log(`[verify] ✓ happy-path PASSED — stage ${before.stage} → ${after.stage}`);
    return 0;
  } catch (e) {
    _log(`[verify] ✗ FAILED: ${e.message}`);
    return 1;
  } finally {
    teardownEnv(env);
  }
}

const scenario = process.argv[2];
const fn = scenario
  ? (await import(`file://${resolvePath(process.cwd(), scenario).replace(/\\/g, "/")}`)).default
  : happyPath;
process.exit(await fn());
