// Smoke 21 — reaper retry for review no-verdict inside budget.
// See reaper.mjs:176+ for the branch under test.
//
// Four cases mirror the plan's Test plan:
//   (a) clean worktree, no report, retries<budget  → re-spawn review (stage=review, retries++)
//   (b) clean worktree, no report, retries>=budget → park at manual [review-stuck-no-report]
//   (c) dirty worktree, retries<budget             → park at manual [review-touched-source] (guard unchanged)
//   (d) report-exists (cli-failed), retries<budget → also re-spawn (transient CLI failure)

import { test } from "node:test";
import { strictEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

import { connectPath, close } from "../scripts/pipeline-db/connection.mjs";
import { projectAdd } from "../scripts/pipeline-db/projects.mjs";
import { rowAdd } from "../scripts/pipeline-db/rows.mjs";
import { reconcileSessions } from "../scripts/orchestrator/reaper.mjs";
import { featureWorktreePath, reportPath } from "../scripts/worktree-paths.mjs";

const DEAD_PID = 999999;

// Resolve git once. Node's spawnSync on Windows does NOT see /mingw64/bin
// even when the parent shell does — it uses process.env.PATH, which is
// minimal under bare node. Walk the standard install paths and fall back to
// `where` (PowerShell/cmd) so the fixture works on any host with git.
function resolveGit() {
  const candidates = [
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\mingw64\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  for (const cmd of [
    ["cmd", ["/c", "where", "git"]],
    ["where", ["git"]],
  ]) {
    const r = spawnSync(cmd[0], cmd[1], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first) return first;
    }
  }
  throw new Error("git not found on PATH — install Git for Windows");
}
const GIT = resolveGit();
// The reaper itself spawns bare `git` (relying on PATH). Mirror production
// by ensuring Node can resolve it: prepend the directory of the resolved
// git.exe so spawnSync("git", ...) succeeds.
const gitDir = dirname(GIT);
if (process.env.PATH && !process.env.PATH.split(";").includes(gitDir)) {
  process.env.PATH = `${gitDir};${process.env.PATH}`;
} else if (!process.env.PATH) {
  process.env.PATH = gitDir;
}

function seedDeadReviewSession(db, { project, feature, correlationId = "test-corr" }) {
  db.prepare(
    "INSERT INTO sessions (correlation_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
  ).run(correlationId, project, feature, "review", "/tmp", "sessions/review-1.md", new Date().toISOString(), DEAD_PID);
}

// Each test gets a UNIQUE projectRoot so that the worktree path
// `{root_parent}/.worktrees/{project}/{feature}` resolves to a unique dir
// across tests. (mkdtempSync gives unique dirs, but they share a common
// parent under tmpdir — without a unique {project} in the path, sibling tests
// overwrite each other's worktree + reports and produce false-positive
// "report exists" matches.) We also use a unique feature slug for the same
// reason — even though {feature} is the last segment of the worktree path,
// having both knobs unique avoids any collision when run in CI.
function setupTempProject({ feature = "feat-x", dirtyWorktree = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `reaper-review-retry-${feature}-`));
  spawnSync(GIT, ["init", "-q"], { cwd: root, windowsHide: true });
  const plans = join(root, "plans");
  mkdirSync(plans, { recursive: true });
  const planFile = join(plans, `${feature}.md`);
  writeFileSync(planFile, "# Plan\n\nPlan body.\n");

  const wtDir = featureWorktreePath({ project: feature, projectRoot: root, feature });
  mkdirSync(wtDir, { recursive: true });
  spawnSync(GIT, ["init", "-q"], { cwd: wtDir, windowsHide: true });
  writeFileSync(join(wtDir, "tracked.txt"), "first version\n");
  spawnSync(GIT, ["add", "tracked.txt"], { cwd: wtDir, windowsHide: true });
  spawnSync(GIT, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: wtDir, windowsHide: true });
  if (dirtyWorktree) {
    writeFileSync(join(wtDir, "tracked.txt"), "second version (dirty)\n");
  }
  return { root, planFile, wtDir };
}

test("reaper: review no-verdict within budget → re-spawns review", () => {
  const feature = "feat-retry";
  const { root, planFile, wtDir } = setupTempProject({ feature });
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: feature, rootPath: root });
    rowAdd(db, feature, {
      feature,
      planFile,
      stage:   "review",
      branch:  `autonomous/${feature}`,
      reviewRetries: 1,
      reviewRetryBudget: 3,
    });
    seedDeadReviewSession(db, { project: feature, feature, correlationId: "test-corr-retry" });

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, review_retries, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get(feature, feature);

    strictEqual(row.stage, "review", "row should advance to review (re-spawn)");
    strictEqual(row.review_retries, 2, "review_retries should increment from 1 → 2");
    match(row.notes_extra, /\[review-no-verdict-retry 2\/3/, "should carry the retry annotation");
    ok(
      logs.some(l => l.msg.includes("re-spawning within budget") && l.level === "WARN"),
      "should log the re-spawn decision at WARN"
    );
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(wtDir), { recursive: true, force: true });
  }
});

test("reaper: review no-verdict with budget exhausted → parks at manual", () => {
  const feature = "feat-exhaust";
  const { root, planFile, wtDir } = setupTempProject({ feature });
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: feature, rootPath: root });
    rowAdd(db, feature, {
      feature,
      planFile,
      stage:   "review",
      branch:  `autonomous/${feature}`,
      reviewRetries: 3,
      reviewRetryBudget: 3,
    });
    seedDeadReviewSession(db, { project: feature, feature, correlationId: "test-corr-exhaust" });

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get(feature, feature);

    strictEqual(row.stage, "manual", "exhausted budget should park at manual (terminal case)");
    match(row.notes_extra, /\[review-stuck-no-report/, "should carry the no-report marker");
    ok(
      logs.some(l => l.msg.includes("parking at manual") && l.level === "ERROR"),
      "should log the park decision at ERROR"
    );
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(wtDir), { recursive: true, force: true });
  }
});

test("reaper: review no-verdict with dirty worktree → parks regardless of budget", () => {
  const feature = "feat-dirty";
  const { root, planFile, wtDir } = setupTempProject({ feature, dirtyWorktree: true });
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: feature, rootPath: root });
    rowAdd(db, feature, {
      feature,
      planFile,
      stage:   "review",
      branch:  `autonomous/${feature}`,
      reviewRetries: 1,
      reviewRetryBudget: 3,
    });
    seedDeadReviewSession(db, { project: feature, feature, correlationId: "test-corr-dirty" });

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, review_retries, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get(feature, feature);

    strictEqual(row.stage, "manual", "dirty worktree should always park");
    strictEqual(row.review_retries, 1, "review_retries must NOT increment on dirty-worktree guard");
    match(row.notes_extra, /\[review-touched-source/, "should carry the touched-source marker");
    ok(!/review-no-verdict-retry/.test(row.notes_extra || ""), "should NOT carry the retry marker");
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(wtDir), { recursive: true, force: true });
  }
});

test("reaper: review no-verdict with report-exists (cli-failed) within budget → also re-spawns", () => {
  const feature = "feat-clifail";
  const { root, planFile, wtDir } = setupTempProject({ feature });
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    const { dir: reportsDir } = reportPath({
      kind: "code-review", project: feature, projectRoot: root, feature, retryN: 1,
    });
    mkdirSync(reportsDir, { recursive: true });
    // regex looks for retryN+1 = retry2; filename must include the feature.
    writeFileSync(join(reportsDir, `review-report-2026-06-28-${feature}-retry2-test.md`), "x");

    projectAdd(db, { name: feature, rootPath: root });
    rowAdd(db, feature, {
      feature,
      planFile,
      stage:   "review",
      branch:  `autonomous/${feature}`,
      reviewRetries: 1,
      reviewRetryBudget: 3,
    });
    seedDeadReviewSession(db, { project: feature, feature, correlationId: "test-corr-clifail" });

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, review_retries, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get(feature, feature);

    strictEqual(row.stage, "review", "report-exists within budget should re-spawn, not park");
    strictEqual(row.review_retries, 2, "review_retries should increment");
    match(row.notes_extra, /\[review-no-verdict-retry/, "should carry the retry marker (transient CLI failure)");
    ok(
      logs.some(l => l.msg.includes("re-spawning within budget") && l.level === "WARN"),
      "should log the re-spawn decision"
    );
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(wtDir), { recursive: true, force: true });
  }
});

test("reaper: review no-verdict with report-exists AND budget exhausted → parks [review-stuck-cli-failed]", () => {
  const feature = "feat-cliexhaust";
  const { root, planFile, wtDir } = setupTempProject({ feature });
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    const { dir: reportsDir } = reportPath({
      kind: "code-review", project: feature, projectRoot: root, feature, retryN: 3,
    });
    mkdirSync(reportsDir, { recursive: true });
    // retryN=3 → regex matches `retry4`.
    writeFileSync(join(reportsDir, `review-report-2026-06-28-${feature}-retry4-test.md`), "x");

    projectAdd(db, { name: feature, rootPath: root });
    rowAdd(db, feature, {
      feature,
      planFile,
      stage:   "review",
      branch:  `autonomous/${feature}`,
      reviewRetries: 3,
      reviewRetryBudget: 3,
    });
    seedDeadReviewSession(db, { project: feature, feature, correlationId: "test-corr-cli-exhaust" });

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });

    reconcileSessions(db, { logFn, dryRun: true });

    const row = db.prepare(
      "SELECT stage, notes_extra FROM pipeline_rows WHERE project=? AND feature=?"
    ).get(feature, feature);

    strictEqual(row.stage, "manual", "report-exists + budget exhausted should park");
    match(row.notes_extra, /\[review-stuck-cli-failed/, "should carry the cli-failed marker (not no-report)");
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(wtDir), { recursive: true, force: true });
  }
});

// Smoke: dev and test recovery paths must be unchanged by the review-edit.
// The full dev-recovery surface is already covered by reaper-dev-recovery.test.mjs;
// this confirms the import is still resolvable and reconcileSessions doesn't
// regress on the dev branch when imported.
test("reaper: review-edit does not break reconcileSessions import (smoke)", () => {
  const feature = "feat-smoke";
  const { root, planFile } = setupTempProject({ feature });
  const dbPath = join(root, ".pipeline", "pipeline.db");
  const db = connectPath(dbPath);
  try {
    projectAdd(db, { name: feature, rootPath: root });
    rowAdd(db, feature, { feature, planFile, stage: "dev", branch: `autonomous/${feature}` });
    db.prepare("UPDATE pipeline_rows SET notes_extra=? WHERE project=? AND feature=?")
      .run("type=dev sessions/dev-1.md", feature, feature);
    db.prepare(
      "INSERT INTO sessions (correlation_id, project, feature, session_type, cwd, session_file, spawn_time, pid, is_active) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    ).run("test-corr-smoke-dev", feature, feature, "dev", "/tmp", "sessions/dev-1.md", new Date().toISOString(), DEAD_PID);

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level: level || "INFO" });
    reconcileSessions(db, { logFn, dryRun: true });
    ok(true, "reconcileSessions completes without error");
  } finally {
    close(db);
    rmSync(root, { recursive: true, force: true });
  }
});