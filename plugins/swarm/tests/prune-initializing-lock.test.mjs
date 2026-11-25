// A killed `worktree add` leaves its tree locked with reason `initializing`; git refuses a
// single-force removal, so prune must read the reason and override only that one.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { blockers, execute, makeGit, plan } from "../src/prune.mjs";
import { runScopeKey, treeDirFor } from "../src/worktree.mjs";
import { runCliInProcess } from "./helpers/cli.mjs";
import { commitAll, gitOut } from "./helpers/cli-fixture.mjs";
import { dropSnapPrune, pruneFixture, writeFinishedRun } from "./helpers/prune-fixture.mjs";

const cfgOf = (f) => ({ treeRoot: join(f.dir, "home", "worktrees") });

// A real tree a killed `worktree add` leaves: a branch off the base commit (so it reads as
// landed) or a detached HEAD, locked with `reason` when given and with no reason otherwise.
function addLockedTree(f, { name = "impl", branch = true, reason = null } = {}) {
  const tree = treeDirFor(f.resultsDir, name, cfgOf(f));
  const branchName = branch ? `swarm/${runScopeKey(f.resultsDir)}/${name}` : null;
  const add = ["worktree", "add", "-q", ...(branchName ? ["-b", branchName] : ["--detach"]), tree, f.sha];
  const made = spawnSync("git", add, { cwd: f.repo, windowsHide: true, encoding: "utf8" });
  equal(made.status, 0, `worktree add: ${made.stderr}`);
  const lock = ["worktree", "lock", ...(reason === null ? [] : ["--reason", reason]), tree];
  const locked = spawnSync("git", lock, { cwd: f.repo, windowsHide: true, encoding: "utf8" });
  equal(locked.status, 0, `worktree lock: ${locked.stderr}`);
  return { tree, branch: branchName };
}

const rowOf = (f, t) => ({ path: t.tree, branch: t.branch, repo: f.repo, bytes: 0, dirty: 0, unlanded: 0 });

const pruneRows = (f, rows) => execute(rows, makeGit(spawnSync), nodeFs, { resultsDir: f.resultsDir, cfg: cfgOf(f) });

test("a tree locked initializing is removed with -f -f, and its branch with it", () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { reason: "initializing" });
    const { failed } = pruneRows(f, [rowOf(f, t)]);
    deepEqual(failed, []);
    ok(!nodeFs.existsSync(t.tree), "the tree a killed add left behind is gone");
    equal(gitOut(["branch", "--list", t.branch], f.repo), "", "and so is its branch");
  } finally {
    dropSnapPrune(f);
  }
});

test("a detached tree locked initializing is removed too", () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { name: "detached", branch: false, reason: "initializing" });
    const { failed } = pruneRows(f, [rowOf(f, t)]);
    deepEqual(failed, []);
    ok(!nodeFs.existsSync(t.tree), "the detached tree is gone");
  } finally {
    dropSnapPrune(f);
  }
});

test("a tree locked for another reason is kept, and the failure names the reason and the unlock", () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { reason: "operator hold" });
    const { failed } = pruneRows(f, [rowOf(f, t)]);
    equal(failed.length, 1);
    const reason = failed[0].reason;
    ok(/cannot remove a locked working tree/.test(reason), `git's own refusal is kept: ${reason}`);
    ok(reason.includes("operator hold"), `the reason is named: ${reason}`);
    ok(reason.includes(`git worktree unlock "${t.tree}"`), `the unlock is named: ${reason}`);
    ok(nodeFs.existsSync(t.tree), "a lock set on purpose is never overridden");
    ok(gitOut(["branch", "--list", t.branch], f.repo), "and its branch survives");
  } finally {
    dropSnapPrune(f);
  }
});

test("a tree locked with no reason is kept, and the failure says the lock carries none", () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { reason: null });
    const { failed } = pruneRows(f, [rowOf(f, t)]);
    equal(failed.length, 1);
    const reason = failed[0].reason;
    ok(/cannot remove a locked working tree/.test(reason), `git's own refusal is kept: ${reason}`);
    ok(/no reason recorded/.test(reason), `a bare lock is reported as such: ${reason}`);
    ok(reason.includes(`git worktree unlock "${t.tree}"`), `the unlock is named: ${reason}`);
    ok(nodeFs.existsSync(t.tree), "a reasonless lock is never overridden");
  } finally {
    dropSnapPrune(f);
  }
});

test("a detached tree locked for another reason is kept, not swept by the double force", () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { name: "detached", branch: false, reason: "operator hold" });
    const { failed } = pruneRows(f, [rowOf(f, t)]);
    equal(failed.length, 1);
    ok(failed[0].reason.includes(`git worktree unlock "${t.tree}"`), `the unlock is named: ${failed[0].reason}`);
    ok(nodeFs.existsSync(t.tree), "a detached tree a user locked on purpose survives");
  } finally {
    dropSnapPrune(f);
  }
});

test("a tree locked for another reason survives when git cannot list the locks", () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { name: "detached", branch: false, reason: "operator hold" });
    const real = makeGit(spawnSync);
    // A listing git cannot answer is not an unlocked tree: the removal still reaches the
    // real repo and git still refuses it, so the row is kept.
    const blind = (args, cwd, opts) => (args[0] === "worktree" && args[1] === "list"
      ? { status: 128, stdout: "", stderr: "fatal: unable to read worktrees" }
      : real(args, cwd, opts));
    const { failed } = execute([rowOf(f, t)], blind, nodeFs, { resultsDir: f.resultsDir, cfg: cfgOf(f) });
    equal(failed.length, 1, "the removal is reported as failed");
    ok(nodeFs.existsSync(t.tree), "a lock prune could not read is never overridden");
  } finally {
    dropSnapPrune(f);
  }
});

test("a lock is found when the row spells the tree's path through a link", (t) => {
  const f = pruneFixture();
  try {
    const tree = addLockedTree(f, { name: "detached", branch: false, reason: "operator hold" });
    const alias = join(f.dir, "alias");
    try {
      nodeFs.symlinkSync(tree.tree, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      t.skip(`cannot link a directory here: ${e.code || e.message}`);
      return;
    }
    const { failed } = execute([{ ...rowOf(f, tree), path: alias }], makeGit(spawnSync), nodeFs,
      { resultsDir: f.resultsDir, cfg: cfgOf(f) });
    equal(failed.length, 1);
    ok(failed[0].reason.includes("operator hold"), `the lock is read through the link: ${failed[0].reason}`);
    ok(nodeFs.existsSync(tree.tree), "the tree survives");
  } finally {
    dropSnapPrune(f);
  }
});

test("the CLI names the lock, and quotes the unlock for a path with a space", async () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { name: "impl tree", branch: false, reason: "operator hold" });
    writeFinishedRun(f.resultsDir, [{ branch: t.branch, path: t.tree, repo: f.repo }]);
    const r = await runCliInProcess(["prune", f.resultsDir], {
      cwd: f.dir,
      env: { SWARM_HOME: join(f.dir, "home") },
      config: cfgOf(f),
    });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("operator hold"), `the reason reaches stderr: ${r.stderr}`);
    ok(r.stderr.includes(`git worktree unlock "${t.tree}"`), `the quoted unlock reaches stderr: ${r.stderr}`);
    ok(nodeFs.existsSync(t.tree), "the tree is kept");
  } finally {
    dropSnapPrune(f);
  }
});

test("a dirty or unlanded tree locked initializing is still held back as a blocker", async () => {
  const f = pruneFixture();
  try {
    const t = addLockedTree(f, { reason: "initializing" });
    nodeFs.writeFileSync(join(t.tree, "work.txt"), "unlanded\n");
    commitAll(t.tree, "unlanded work");
    nodeFs.writeFileSync(join(t.tree, "after.txt"), "dirty\n");

    const run = { live: false, repos: [f.repo], resultsDir: f.resultsDir, worktreesKept: [{ branch: t.branch, path: t.tree, repo: f.repo }] };
    const { rows } = plan(run, makeGit(spawnSync), nodeFs,
      { cfg: cfgOf(f), extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
    equal(rows.length, 1, JSON.stringify(rows));
    ok(rows[0].unlanded > 0, `the unlanded commit is measured: ${rows[0].unlanded}`);
    ok(rows[0].dirty > 0, `the uncommitted file is measured: ${rows[0].dirty}`);
    deepEqual(blockers(rows), rows, "the lock is no licence to destroy work");

    writeFinishedRun(f.resultsDir, [{ branch: t.branch, path: t.tree, repo: f.repo }]);
    const r = await runCliInProcess(["prune", f.resultsDir], {
      cwd: f.dir,
      env: { SWARM_HOME: join(f.dir, "home") },
      config: cfgOf(f),
    });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(nodeFs.existsSync(t.tree), "prune keeps the work it cannot account as landed");
    ok(gitOut(["branch", "--list", t.branch], f.repo), "and the branch it sits on");
  } finally {
    dropSnapPrune(f);
  }
});
