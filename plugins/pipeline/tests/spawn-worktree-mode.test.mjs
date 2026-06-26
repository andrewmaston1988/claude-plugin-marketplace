// Phase 3b: one worktree per feature. All session types resolve to the same
// path. The stash-pop-conflict recovery path is exercised by simulating the
// dance against a temp git repo.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Suppress deprecation warns from compat wrappers that some imports still trigger.
process.env.PIPELINE_SUPPRESS_DEPRECATED = "1";

import { featureWorktreePath, reportPath } from "../src/worktree-paths.mjs";

const FEATURE  = "feat-y";
const PROJECT  = "p";
const PROJROOT = "/x/p";
const CFG      = {}; // use defaults

// ── All session types route to the single worktree ───────────────────────────

test("dev / research / review / test resolve to one feature worktree", () => {
  const wt = featureWorktreePath({ project: PROJECT, projectRoot: PROJROOT, feature: FEATURE, _config: CFG });
  // Default template is {root_parent}/.worktrees/{project}/{feature}
  equal(wt, "/x/.worktrees/p/feat-y");
  // reportPath consults featureWorktreePath internally; both kinds nest under it.
  const cr = reportPath({ kind: "code-review", project: PROJECT, projectRoot: PROJROOT, feature: FEATURE, _config: CFG });
  const qa = reportPath({ kind: "qa-test",     project: PROJECT, projectRoot: PROJROOT, feature: FEATURE, _config: CFG });
  equal(cr.wt, wt);
  equal(qa.wt, wt);
  equal(cr.dir, `${wt}/reports`);
  equal(qa.dir, `${wt}/test-reports`);
});

test("reportPath emits publishBranch from cfg.report_publish_branch_template", () => {
  const cr = reportPath({ kind: "code-review", project: PROJECT, projectRoot: PROJROOT, feature: FEATURE, _config: CFG });
  const qa = reportPath({ kind: "qa-test",     project: PROJECT, projectRoot: PROJROOT, feature: FEATURE, _config: CFG });
  equal(cr.publishBranch, "code-review/feat-y");
  equal(qa.publishBranch, "qa-test/feat-y");
});

test("operator can override report_publish_branch_template", () => {
  const cfg = { report_publish_branch_template: "verdicts/{kind}--{feature}" };
  const cr = reportPath({ kind: "code-review", project: PROJECT, projectRoot: PROJROOT, feature: FEATURE, _config: cfg });
  equal(cr.publishBranch, "verdicts/code-review--feat-y");
});

// ── Stash-pop-conflict path against a real temp git repo ─────────────────────
//
// Builds a worktree, makes a dirty edit on the dev branch, then runs the
// publish dance with a side-branch edit that conflicts on stash pop. Verifies:
//   1. The publish-branch commit lands.
//   2. The stash is preserved when pop conflicts (operator recovery path).

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

test("stash-switchback dance: pop conflict leaves stash preserved", () => {
  // Realistic conflict: WIP creates an untracked file. The publish branch
  // commits a file at the same path. When we switch back to dev and try to
  // pop the stash, the untracked file in the working tree (from the publish
  // commit) blocks the stash's untracked entry → "already exists" conflict.
  const tmp = mkdtempSync(join(tmpdir(), "spawn-wt-mode-"));
  try {
    git(tmp, "init", "-q", "-b", "main");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    git(tmp, "checkout", "-b", "autonomous/feat-y");
    writeFileSync(join(tmp, "base.txt"), "base\n");
    git(tmp, "add", "base.txt");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "dev base");

    // WIP: untracked file at clash.txt.
    writeFileSync(join(tmp, "clash.txt"), "dev WIP content\n");

    // Dance step 1: stash WIP (-u includes untracked).
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "stash", "push", "-u", "-m", "auto: code-review-feat-y");
    // Step 2: side branch.
    git(tmp, "checkout", "-B", "code-review/feat-y");
    // Step 3: commit a clashing file at the same path + the report.
    mkdirSync(join(tmp, "reports"), { recursive: true });
    writeFileSync(join(tmp, "clash.txt"), "review-published\n");
    writeFileSync(join(tmp, "reports", "review-report.md"), "verdict\n");
    git(tmp, "add", "clash.txt", "reports/review-report.md");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "code-review: feat-y retry1");
    // Step 4: back to dev branch. clash.txt from publish branch is gone
    // because dev branch never had it... actually checkout removes it. Force
    // an untracked clash by writing it after the checkout.
    git(tmp, "checkout", "autonomous/feat-y");
    writeFileSync(join(tmp, "clash.txt"), "different untracked content\n");
    // Step 5: pop the stash — untracked clash blocks "already exists".
    const pop = spawnSync("git", ["stash", "pop"], { cwd: tmp, encoding: "utf8", windowsHide: true });
    ok(pop.status !== 0, `stash pop should fail; got status=${pop.status} stderr=${pop.stderr}`);

    // Preservation: stash list still has our entry.
    const list = git(tmp, "stash", "list");
    ok(list.includes("auto: code-review-feat-y"), `stash should be preserved: ${list}`);

    // Publish-branch commit landed.
    const log = git(tmp, "log", "--format=%s", "code-review/feat-y");
    ok(log.includes("code-review: feat-y retry1"), `publish commit missing: ${log}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

// ── Regression: test-session.md scope-excludes test-reports/ from the stash ──
//
// test-session.md cannot use the review-session re-order (stash → checkout →
// write) because the test report is built incrementally throughout the session.
// Instead it stashes with `-- . ':!test-reports/'` so the report directory
// stays in the working tree across the branch switch. This test pins that
// behaviour: with the pathspec exclusion, an untracked file in test-reports/
// must survive `git stash push -u` (and a subsequent `git add` must succeed).
test("test-session dance: stash with pathspec keeps test-reports/ in working tree", () => {
  const tmp = mkdtempSync(join(tmpdir(), "spawn-wt-test-mode-"));
  try {
    git(tmp, "init", "-q", "-b", "main");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    git(tmp, "checkout", "-b", "autonomous/feat-y");

    // Simulate a test session: report written before the publish dance.
    mkdirSync(join(tmp, "test-reports"), { recursive: true });
    writeFileSync(join(tmp, "test-reports", "test-report.md"), "verdict: pass\n");
    // Also some dev WIP (untracked, outside test-reports/) that SHOULD stash.
    writeFileSync(join(tmp, "wip.txt"), "dev WIP\n");

    // Scope-excluded stash: keep test-reports/ in the working tree.
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t",
        "stash", "push", "-u", "-m", "auto: qa-test-feat-y", "--", ".", ":!test-reports/");
    // Report must still exist in the working tree.
    ok(existsSync(join(tmp, "test-reports", "test-report.md")),
       "test-reports/ must survive stash push -u with pathspec exclusion");
    // Dev WIP must have been stashed.
    ok(!existsSync(join(tmp, "wip.txt")), "non-excluded WIP should stash away");

    // The follow-up add+commit on the publish branch must succeed because the
    // report is still there.
    git(tmp, "checkout", "-B", "qa-test/feat-y");
    git(tmp, "add", "test-reports/test-report.md");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "qa-test: feat-y");
    const log = git(tmp, "log", "--format=%s", "qa-test/feat-y");
    ok(log.includes("qa-test: feat-y"), `publish commit missing: ${log}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

// ── Regression: review-session.md writes the report AFTER stash + checkout ───
//
// The earlier bug was the template writing the report before `git stash push
// -u`, which then stashed the untracked report away. This test simulates the
// fixed ordering and asserts a working publish commit.
test("review-session dance: write-after-stash ordering reaches the publish branch", () => {
  const tmp = mkdtempSync(join(tmpdir(), "spawn-wt-review-mode-"));
  try {
    git(tmp, "init", "-q", "-b", "main");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    git(tmp, "checkout", "-b", "autonomous/feat-y");

    // Untracked dev WIP exists before the dance.
    writeFileSync(join(tmp, "wip.txt"), "dev WIP\n");

    // Step 1: stash WIP.
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t",
        "stash", "push", "-u", "-m", "auto: code-review-feat-y");
    ok(!existsSync(join(tmp, "wip.txt")), "WIP should stash");
    // Step 2: publish branch.
    git(tmp, "checkout", "-B", "code-review/feat-y");
    // Step 3: write the report AFTER stash+checkout.
    mkdirSync(join(tmp, "reports"), { recursive: true });
    writeFileSync(join(tmp, "reports", "review-report.md"), "verdict: ready_to_ship\n");
    // Step 4: add + commit must succeed.
    git(tmp, "add", "reports/review-report.md");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "code-review: feat-y retry1");
    const log = git(tmp, "log", "--format=%s", "code-review/feat-y");
    ok(log.includes("code-review: feat-y retry1"), `publish commit missing: ${log}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

// ── Defaults sanity: featureWorktreePath default shape is per-feature ────────

test("default worktree_base is per-feature, not per-branch", () => {
  // Distinct branches for the same feature should be a non-question — there
  // is only one worktree per feature.
  const a = featureWorktreePath({ project: "p", projectRoot: "/r/p", feature: "x", _config: {} });
  const b = featureWorktreePath({ project: "p", projectRoot: "/r/p", feature: "x", _config: {} });
  equal(a, b);
  equal(a, "/r/.worktrees/p/x");
});

// ── doctor stale check ───────────────────────────────────────────────────────

test("doctor worktree-layout-stale: warns on path that doesn't match template", async () => {
  // Build a real git repo with two worktrees: one at the canonical phase-3b
  // path, one at the legacy phase-3a path. The doctor must warn on the legacy.
  const root = mkdtempSync(join(tmpdir(), "doctor-wt-"));
  try {
    const projectRoot = join(root, "myproj");
    mkdirSync(projectRoot, { recursive: true });
    git(projectRoot, "init", "-q", "-b", "main");
    git(projectRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");

    const canonical = join(root, ".worktrees", "myproj", "feat-x").replace(/\\/g, "/");
    const legacy    = join(root, "myproj-wt", "autonomous-feat-x").replace(/\\/g, "/");
    git(projectRoot, "worktree", "add", "-b", "autonomous/feat-x", canonical);
    git(projectRoot, "worktree", "add", "-b", "research/feat-x",  legacy);

    // Stand up a minimal pipeline path-set so runDoctor can run end-to-end.
    const { runDoctor } = await import("../src/setup/doctor.mjs");
    const dataDir   = join(root, "data");
    const stateDir  = join(root, "state");
    const configDir = join(root, "cfg");
    mkdirSync(configDir, { recursive: true });
    const cfgPath = join(configDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({}, null, 2), "utf8");

    // Build a fake unified DB via the real connector so projectList works.
    const { connectUnified } = await import("../src/db/connection.mjs");
    const paths = { stateDir, dataDir, configDir };
    const db = connectUnified(paths);
    const { projectAdd } = await import("../src/db/projects.mjs");
    projectAdd(db, { name: "myproj", rootPath: projectRoot });

    const results = await runDoctor({ paths, configPath: cfgPath, db });
    const stale = results.find(r => r.label === "worktree-layout-stale");
    ok(stale, "stale check ran");
    ok(stale.warn || !stale.ok, `stale warning expected, got: ${JSON.stringify(stale)}`);
    ok(stale.detail.includes("autonomous-feat-x") || stale.detail.includes(legacy),
       `legacy path should appear in detail: ${stale.detail}`);
    const { close } = await import("../src/db/connection.mjs");
    try { close(db); } catch {}
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
});

// ── Regression: post-dance state — report-on-publish-branch, gone from disk ──
//
// After the stash-switchback dance commits the report on the publish branch
// and checks back out to autonomous/{feature}, the report file is removed
// from the dev-branch working tree (because the file is tracked on the
// publish branch but not on the dev branch). The retry-2 review pinned this
// as the BLOCKER: review-complete/test-complete would then fail at
// `existsSync(reportPath)` or at `git add` with `pathspec did not match`.
//
// The fix accepts a `--publish-branch` flag and probes the side-branch via
// `git cat-file -e <pb>:<relpath>`. This test pins the precondition the
// helper now relies on: after the dance, the file is NOT on disk but IS
// reachable from the publish branch via cat-file.
test("post-dance: report absent from working tree but reachable from publish branch", () => {
  const tmp = mkdtempSync(join(tmpdir(), "spawn-wt-postdance-"));
  try {
    git(tmp, "init", "-q", "-b", "main");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    git(tmp, "checkout", "-b", "autonomous/feat-y");

    // Simulate the full review-session dance: stash → checkout pb → write → commit → checkout dev.
    // Need some untracked WIP so stash push -u has something to stash.
    writeFileSync(join(tmp, "wip.txt"), "dev WIP\n");
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t",
        "stash", "push", "-u", "-m", "auto: code-review-feat-y");
    git(tmp, "checkout", "-B", "code-review/feat-y");
    mkdirSync(join(tmp, "reports"), { recursive: true });
    const reportRel = "reports/review-report-2026-06-10-feat-y-retry1.md";
    writeFileSync(join(tmp, reportRel), "verdict: needs_work\n");
    git(tmp, "add", reportRel);
    git(tmp, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "code-review: feat-y retry1");
    git(tmp, "checkout", "autonomous/feat-y");

    // Post-dance precondition: file is GONE from working tree on the dev branch.
    ok(!existsSync(join(tmp, reportRel)),
       "post-dance: report file must not be present in dev-branch working tree");

    // But it IS reachable from the publish branch — this is what the helper probes.
    const probe = spawnSync("git", ["cat-file", "-e", `code-review/feat-y:${reportRel}`],
                            { cwd: tmp, encoding: "utf8" });
    equal(probe.status, 0,
          `git cat-file -e code-review/feat-y:${reportRel} must succeed: stderr=${probe.stderr}`);

    // The corresponding `git show` must return the report content (dev-session.md
    // discovery relies on this to read prior reviewer feedback).
    const show = spawnSync("git", ["show", `code-review/feat-y:${reportRel}`],
                           { cwd: tmp, encoding: "utf8" });
    equal(show.status, 0, `git show must succeed: stderr=${show.stderr}`);
    ok(show.stdout.includes("needs_work"),
       `git show output must contain report content: ${show.stdout}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});
