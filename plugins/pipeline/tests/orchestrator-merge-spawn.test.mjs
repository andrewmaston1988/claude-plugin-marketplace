// orchestrator-merge-spawn.test.mjs — regression guard for the activeProcs
// ReferenceError in pollOnce's merge-spawn path. Spawns the orchestrator in
// --once --dry-run mode against a fixture row at stage=merge and asserts:
//   1. exit code 0
//   2. no "activeProcs" ReferenceError in stderr
//   3. "DRY-RUN" appears in the log (proves spawnMerge was reached)
import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { connectPath, close } from "../src/db/connection.mjs";
import { projectAdd } from "../src/db/projects.mjs";
import { rowAdd } from "../src/db/rows.mjs";
import { PIPELINE_DEFAULTS } from "../src/config-defaults.mjs";

import { fileURLToPath } from "node:url";
const ORCHESTRATOR = fileURLToPath(new URL("../src/orchestrator/index.mjs", import.meta.url));

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "--initial-branch=master"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "init\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

// Add a feature branch with one commit so isMergedInto(target, feature, root)
// has a meaningful answer (false → model = haiku, true → model = sonnet).
function addFeatureBranch(root, branch) {
  spawnSync("git", ["checkout", "-q", "-b", branch], { cwd: root });
  writeFileSync(join(root, "feat.txt"), "feature work\n", "utf8");
  spawnSync("git", ["add", "feat.txt"], { cwd: root });
  spawnSync("git", ["commit", "-m", "feat"], { cwd: root });
  spawnSync("git", ["checkout", "-q", "master"], { cwd: root });
}

// Compute platform-appropriate dirs matching getPaths() output for a given home.
// On Linux getPaths() uses XDG; on Windows/macOS it uses <home>/.pipeline.
function platformDirs(home) {
  if (process.platform === "linux") {
    const data  = join(home, ".local", "share");
    const state = join(home, ".local", "state");
    return {
      dataDir:  join(data,  "pipeline"),
      logDir:   join(state, "pipeline", "logs"),
      xdgEnv: { XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: data, XDG_STATE_HOME: state },
    };
  }
  return {
    dataDir:  join(home, ".pipeline"),
    logDir:   join(home, ".pipeline", "logs"),
    xdgEnv: {},
  };
}

function freshFixture() {
  const root = mkdtempSync(join(tmpdir(), "orch-merge-spawn-"));
  initRepo(root);
  addFeatureBranch(root, "autonomous/feat");

  const { dataDir, logDir, xdgEnv } = platformDirs(root);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logDir,  { recursive: true });

  // DB at dataDir (connectUnified uses paths.dataDir, not stateDir).
  const db = connectPath(join(dataDir, "pipeline.db"));
  projectAdd(db, { name: "test-proj", rootPath: root });

  rowAdd(db, "test-proj", {
    feature:    "feat",
    planFile:   "plans/feat.md",
    stage:      "merge",
    branch:     "autonomous/feat",
    targetBranch: "master",
  });

  // Config at ~/.pipeline/config.json (loadPipelineConfig reads homedir()/.pipeline).
  const pipelineDir = join(root, ".pipeline");
  mkdirSync(pipelineDir, { recursive: true });
  const config = {
    ...PIPELINE_DEFAULTS,
    autoMerge: true,
    governor:  { ...PIPELINE_DEFAULTS.governor, enabled: false },
  };
  writeFileSync(join(pipelineDir, "config.json"), JSON.stringify(config, null, 2), "utf8");

  return { root, db, logDir, xdgEnv };
}

test("pollOnce: merge-spawn path does not throw ReferenceError (activeProcs regression)", () => {
  const { root, db, logDir, xdgEnv } = freshFixture();
  const logFile = join(logDir, "orchestrator.jsonl");
  try {
    const r = spawnSync(process.execPath, [
      ORCHESTRATOR, "--once", "--dry-run", "--project", "test-proj",
    ], {
      env: { ...process.env, HOME: root, USERPROFILE: root, ...xdgEnv },
      encoding: "utf8",
      timeout: 10_000,
    });

    strictEqual(r.status, 0,
      `orchestrator --once exited ${r.status}\n` +
      `stdout: ${r.stdout}\n` +
      `stderr: ${r.stderr}`);
    ok(!r.stderr.includes("activeProcs is not defined"),
      `stderr contains activeProcs ReferenceError — fix has regressed.\nstderr: ${r.stderr}`);

    // Lock the --once stdout contract: it must be valid JSON with the
    // documented keys. Also exercises the 150ms setTimeout-flush before exit
    // — without the flush, a piped stdout (as spawnSync uses by default) can
    // be silently truncated and this parse would fail.
    let parsed;
    try { parsed = JSON.parse(r.stdout); }
    catch (e) { ok(false, `stdout is not valid JSON: ${e.message}\nstdout: ${r.stdout}`); }
    ok(parsed && typeof parsed === "object",
      `stdout should parse to a JSON object, got: ${r.stdout}`);
    for (const k of ["nProjects", "nQueued", "nActive"]) {
      ok(k in parsed, `stdout JSON should include '${k}': ${r.stdout}`);
    }

    ok(existsSync(logFile), `expected log file at ${logFile}`);
    const log = readFileSync(logFile, "utf8");
    ok(log.includes("DRY-RUN"),
      `log file should contain a DRY-RUN line proving the merge-spawn path was reached.\nlog: ${log}`);
  } finally {
    try { close(db); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
