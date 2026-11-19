// A worktree that lost its `.git` link: git unregistered it, deleted its branch and
// removed its contents, but the directory survived. Prune must classify that leftover
// from the run's own records — never by running git inside a directory that is no longer
// a worktree, where it walks up to the repo that happens to enclose it.
import "./helpers/isolate-home.mjs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCliInProcess } from "./helpers/cli.mjs";
import { commitAll, gitOut } from "./helpers/cli-fixture.mjs";
import {
  pruneFixture, writeFinishedRun, unlinkedTree, unlinkedRegisteredTree, dropSnapPrune,
} from "./helpers/prune-fixture.mjs";

const env = (f) => ({ SWARM_HOME: join(f.dir, "home") });

// A live branch carrying one commit the default branch does not hold. The throwaway
// worktree only exists long enough to make that commit; the branch outlives it.
function unlandedBranch(f, branch = "swarm/impl") {
  const wt = join(f.dir, "branch-wt");
  spawnSync("git", ["worktree", "add", "-q", "-b", branch, wt, f.sha], { cwd: f.repo, windowsHide: true });
  writeFileSync(join(wt, "work.txt"), "unlanded\n");
  commitAll(wt, "unlanded work");
  spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: f.repo, windowsHide: true });
  return branch;
}

test("A1: an unlinked empty directory whose branch is gone is cleared, and the enclosing repo's files are never its work", async () => {
  const f = pruneFixture();
  try {
    const tree = unlinkedTree(f);
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch: "swarm/impl", path: tree }]);
    // Preconditions: the row's own directory is empty, and the repo that encloses treeRoot
    // is dirty — exactly the state that made a failed prune report unrelated files.
    equal(readdirSync(tree).length, 0, "the leftover directory starts empty");
    ok(gitOut(["status", "--porcelain"], f.dir).includes("parent-dirty-a.txt"), "the enclosing repo is dirty");

    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: env(f) });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(tree), "the empty leftover directory is cleared");
    ok(!/uncommitted/.test(r.stdout + r.stderr), `the enclosing repo's files were counted as the row's work: ${r.stdout}${r.stderr}`);
  } finally {
    dropSnapPrune(f);
  }
});

test("A2: an unlinked directory holding one file is kept and named, with and without --discard-unlanded", async () => {
  const f = pruneFixture();
  try {
    const tree = unlinkedTree(f, { contents: ["leftover.txt"] });
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch: "swarm/impl", path: tree }]);
    for (const args of [["prune", f.resultsDir], ["prune", f.resultsDir, "--discard-unlanded"]]) {
      const r = await runCliInProcess(args, { cwd: f.dir, env: env(f) });
      equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      ok(r.stderr.includes(`unlinked directory ${tree}`), `${args.join(" ")}: ${r.stderr}`);
      ok(existsSync(join(tree, "leftover.txt")), `${args.join(" ")}: the directory and its file must survive`);
    }
  } finally {
    dropSnapPrune(f);
  }
});

test("A3: an unlinked empty directory whose branch is alive and unlanded is kept, measured in the run's repo", async () => {
  const f = pruneFixture();
  try {
    const tree = unlinkedTree(f);
    const branch = unlandedBranch(f);
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch, path: tree }]);

    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: env(f) });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("1 unlanded"), `the branch's own repo must answer: ${r.stderr}`);
    ok(!/unmeasurable/.test(r.stderr), `an unlinked row must never be "unmeasurable": ${r.stderr}`);
    ok(existsSync(tree), "the leftover directory survives the refusal");
    ok(gitOut(["branch", "--list", branch], f.repo), "the unlanded branch survives the refusal");
  } finally {
    dropSnapPrune(f);
  }
});

test("A4: an unlinked empty directory whose branch is landed is cleared, and the branch deleted", async () => {
  const f = pruneFixture();
  try {
    const tree = unlinkedTree(f);
    const branch = unlandedBranch(f);
    spawnSync("git", ["merge", "-q", branch], { cwd: f.repo, windowsHide: true });
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch, path: tree }]);

    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: env(f) });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(tree), "the leftover directory is cleared");
    equal(gitOut(["branch", "--list", branch], f.repo), "", "the landed branch is deleted");
  } finally {
    dropSnapPrune(f);
  }
});

test("A5: a registered, .git-less directory is cleared, its registration pruned, and the next prune finds nothing", async () => {
  const f = pruneFixture();
  try {
    const tree = unlinkedRegisteredTree(f);
    const branch = "swarm/impl";
    spawnSync("git", ["merge", "-q", branch], { cwd: f.repo, windowsHide: true });
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch, path: tree }]);
    ok(gitOut(["worktree", "list", "--porcelain"], f.repo).includes("impl"), "precondition: git still has it registered");

    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: env(f) });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(tree), "the leftover directory is cleared");
    ok(!gitOut(["worktree", "list", "--porcelain"], f.repo).includes("impl"), "the stale registration is gone");
    equal(gitOut(["branch", "--list", branch], f.repo), "", "the landed branch is deleted");

    const again = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: env(f) });
    equal(again.status, 0, again.stdout + again.stderr);
    ok(/nothing to prune/.test(again.stdout), again.stdout);
  } finally {
    dropSnapPrune(f);
  }
});

test("A9: a worktree recorded through a junction is measured as a worktree, not an unlinked leftover", { skip: process.platform !== "win32" }, async () => {
  const f = pruneFixture();
  let junction;
  try {
    const real = join(f.dir, "real-root");
    const realTree = join(real, "wt-impl");
    mkdirSync(real, { recursive: true });
    spawnSync("git", ["worktree", "add", "-q", "-b", "swarm/impl", realTree, f.sha], { cwd: f.repo, windowsHide: true });
    junction = join(f.dir, "link-root");
    symlinkSync(real, junction, "junction");
    // The run records the tree under the junction's spelling while git answers with the
    // canonical one — two spellings of one directory.
    const recorded = join(junction, "wt-impl");
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch: "swarm/impl", path: recorded }]);
    ok(existsSync(recorded), "precondition: the tree is reachable through the junction");

    const r = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env: env(f) });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!/unlinked directory/.test(r.stdout + r.stderr), `a junctioned tree is a worktree, not a leftover: ${r.stdout}${r.stderr}`);
    ok(/would free .* across 1 worktree/.test(r.stdout), `the tree must be measured as a worktree: ${r.stdout}`);
  } finally {
    if (junction) { try { rmdirSync(junction); } catch { /* already gone */ } }
    dropSnapPrune(f);
  }
});

test("A6: --dry-run on an unlinked leftover prints 'would clear' and deletes nothing", async () => {
  const f = pruneFixture();
  try {
    const tree = unlinkedRegisteredTree(f);
    const branch = "swarm/impl";
    spawnSync("git", ["merge", "-q", branch], { cwd: f.repo, windowsHide: true });
    writeFinishedRun(f.resultsDir, [{ name: "impl", branch, path: tree }]);
    const registered = gitOut(["worktree", "list", "--porcelain"], f.repo);

    const r = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env: env(f) });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/would clear/.test(r.stdout), r.stdout);
    ok(r.stdout.includes(tree), r.stdout);
    ok(existsSync(tree), "dry-run keeps the leftover directory");
    equal(gitOut(["worktree", "list", "--porcelain"], f.repo), registered, "dry-run never prunes the registration");
    ok(gitOut(["branch", "--list", branch], f.repo), "dry-run keeps the branch");
  } finally {
    dropSnapPrune(f);
  }
});
