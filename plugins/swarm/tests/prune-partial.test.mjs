// Partial prune: landed rows go, blocked rows stay named, and the report describes
// what actually happened after git ran.
import "./helpers/isolate-home.mjs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCliInProcess } from "./helpers/cli.mjs";
import { commitAll, gitOut } from "./helpers/cli-fixture.mjs";
import { prepareIsolation, runScopeKey, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { dropSnapPrune, pruneFixture, writeFinishedRun } from "./helpers/prune-fixture.mjs";

const cfgFor = (dir) => ({ worktreeBranchPrefix: "swarm/", treeRoot: join(dir, "home", "worktrees") });

// One finished run holding: a landed clean tree, a tree whose commit never landed,
// and a landed branch the run made that no tree holds.
function partialRun() {
  const f = pruneFixture();
  const cfg = cfgFor(f.dir);
  const base = gitOut(["rev-parse", "HEAD"], f.repo);
  const scope = runScopeKey(f.resultsDir);
  const tree = (id) => prepareIsolation(
    { id, originalCwd: f.repo, cwd: f.repo, branchScope: scope },
    cfg, f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base },
  );
  const landed = tree("landed");
  writeFileSync(join(landed.path, "landed.txt"), "landed\n");
  commitAll(landed.path, "landed work");
  spawnSync("git", ["merge", "-q", landed.branch], { cwd: f.repo, windowsHide: true });

  const held = tree("held");
  writeFileSync(join(held.path, "held.txt"), "held\n");
  commitAll(held.path, "held work");

  // A ref at the base the default branch already holds: no tree, nothing to lose.
  const orphan = `swarm/${scope}/orphan`;
  spawnSync("git", ["branch", orphan, base], { cwd: f.repo, windowsHide: true });

  writeFinishedRun(f.resultsDir, [
    { name: "landed", branch: landed.branch, path: landed.path },
    { name: "held", branch: held.branch, path: held.path },
  ]);
  return { f, landed, held, orphan };
}

test("row 10: a partial prune removes the landed rows and keeps the unlanded one", async () => {
  const { f, landed, held, orphan } = partialRun();
  try {
    const env = { SWARM_HOME: join(f.dir, "home") };
    const first = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env });
    equal(first.status, 1, first.stdout + first.stderr);
    ok(!existsSync(landed.path), "the landed tree is removed");
    equal(gitOut(["branch", "--list", landed.branch], f.repo), "", "its branch is removed");
    equal(gitOut(["branch", "--list", orphan], f.repo), "", "the landed branch-only row is removed");
    ok(existsSync(held.path), "the unlanded tree survives");
    ok(gitOut(["branch", "--list", held.branch], f.repo), "its branch survives");
    ok(first.stderr.includes(held.path) && first.stderr.includes("1 unlanded"), first.stderr);
    ok(/^freed .* across 1 worktree and 1 branch$/m.test(first.stdout), first.stdout);

    spawnSync("git", ["merge", "-q", held.branch], { cwd: f.repo, windowsHide: true });
    const second = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env });
    equal(second.status, 0, second.stdout + second.stderr);
    ok(!existsSync(held.path), "the now-landed tree is removed");
    equal(gitOut(["branch", "--list", held.branch], f.repo), "", "its branch is removed");
  } finally {
    dropSnapPrune(f);
  }
});

test("row 11: partial --dry-run lists what would go and what would stay, removing nothing", async () => {
  const { f, landed, held, orphan } = partialRun();
  try {
    const r = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    const [free, keep] = r.stdout.split("would keep");
    ok(free && keep, `dry-run names both halves: ${r.stdout}`);
    ok(free.includes(landed.path), r.stdout);
    ok(free.includes(orphan), r.stdout);
    ok(!free.includes(held.path), `the unlanded row is never under "would free": ${r.stdout}`);
    ok(keep.includes(held.path) && keep.includes("1 unlanded"), r.stdout);
    ok(existsSync(landed.path) && existsSync(held.path), "dry-run removes nothing");
    ok(gitOut(["branch", "--list", orphan], f.repo), "dry-run deletes no branch");
  } finally {
    dropSnapPrune(f);
  }
});

test("row 12: a removal git refuses is reported kept with git's reason, never freed", async () => {
  const f = pruneFixture();
  try {
    const base = gitOut(["rev-parse", "HEAD"], f.repo);
    const wt = prepareIsolation(
      { id: "locked", originalCwd: f.repo, cwd: f.repo, branchScope: runScopeKey(f.resultsDir) },
      cfgFor(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base },
    );
    writeFileSync(join(wt.path, "locked.txt"), "locked\n");
    commitAll(wt.path, "locked work");
    spawnSync("git", ["merge", "-q", wt.branch], { cwd: f.repo, windowsHide: true });
    // A locked tree is one a single --force refuses; the row is otherwise landed and clean.
    const lock = spawnSync("git", ["worktree", "lock", wt.path], { cwd: f.repo, windowsHide: true });
    equal(lock.status, 0, String(lock.stderr));
    writeFinishedRun(f.resultsDir, [{ name: "locked", branch: wt.branch, path: wt.path }]);

    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(!/freed/.test(r.stdout), `a row git refused must never read as freed: ${r.stdout}`);
    ok(r.stderr.includes(wt.path), r.stderr);
    ok(/locked working tree/i.test(r.stderr), `git's own reason is what is printed: ${r.stderr}`);
    ok(/kept 1 row that git refused to remove/.test(r.stderr), `a refused removal is named as git's refusal: ${r.stderr}`);
    ok(!r.stderr.includes("--discard-unlanded"),
      `the flag retries the same removal — it is never the remedy for a refused row: ${r.stderr}`);
    ok(existsSync(wt.path), "the tree git refused to remove is still there");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "its branch is still there");

    // Still no flag advice when the operator already passed it: `--discard-unlanded` sends
    // this row down the same removal git just refused.
    const discarded = await runCliInProcess(["prune", f.resultsDir, "--discard-unlanded"], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(discarded.status, 1, discarded.stdout + discarded.stderr);
    ok(/kept 1 row that git refused to remove/.test(discarded.stderr), discarded.stderr);
    ok(!discarded.stderr.includes("--discard-unlanded"), `never suggest the flag that was just passed: ${discarded.stderr}`);
    ok(existsSync(wt.path), "the locked tree survives --discard-unlanded too");
  } finally {
    dropSnapPrune(f);
  }
});

test("row 13: a run with both kinds of kept row prints both remedies", async () => {
  const { f, landed, held } = partialRun();
  try {
    // The landed tree is locked, so git refuses it; the held tree is blocked on work.
    equal(spawnSync("git", ["worktree", "lock", landed.path], { cwd: f.repo, windowsHide: true }).status, 0);
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/kept 1 row that still holds work — .*--discard-unlanded/.test(r.stderr),
      `the work row keeps the landing advice: ${r.stderr}`);
    ok(/kept 1 row that git refused to remove/.test(r.stderr),
      `the refused row gets its own line: ${r.stderr}`);
    ok(existsSync(landed.path) && existsSync(held.path), "both kinds of row survive");
  } finally {
    dropSnapPrune(f);
  }
});
