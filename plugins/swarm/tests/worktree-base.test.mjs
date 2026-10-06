import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareIsolation, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { git, initRepo, cleanup, commitAll, dropWorktree, CFG, ADD } from "./helpers/worktree-fixtures.mjs";

// ---- the dispatch-commit base: one per repo, fixed when the run starts ----

test("prepareIsolation cuts from the base IT WAS GIVEN, not the live HEAD", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-base-"));
  try {
    const dispatch = git(["rev-parse", "HEAD"], repo);
    // The live checkout moves on (a merge lands) after dispatch, before the tree.
    writeFileSync(join(repo, "merged.txt"), "landed mid-run\n");
    commitAll(repo, "mid-run merge");
    const moved = git(["rev-parse", "HEAD"], repo);
    ok(moved !== dispatch, "precondition: HEAD moved");

    const wt = prepareIsolation({ id: "late", originalCwd: repo, worktreeName: "late" }, CFG, results,
      { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: dispatch });

    equal(git(["rev-parse", "HEAD"], wt.path), dispatch,
      "a tree cut after the checkout moved must still sit on the dispatch commit");
  } finally { cleanup(repo, results); }
});

test("prepareIsolation requires the pinned base and names it in the error", () => {
  // A throwaway repo: the guard must fire before any tree is made, and a caller
  // that forgets `base` must never fall back to reading the live HEAD instead.
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-nobase-"));
  try {
    let error;
    try { prepareIsolation({ id: "x", originalCwd: repo, worktreeName: "x" }, CFG, results, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS }); }
    catch (e) { error = e; }
    ok(error, "a missing base must throw rather than silently reading HEAD");
    ok(/base/.test(error.message), error.message);
  } finally { cleanup(repo, results); }
});

test("a branch checked out in another worktree fails with a guided error naming that tree", () => {
  const repo = initRepo();
  const a = mkdtempSync(join(tmpdir(), "swarm-wt-inuse-a-"));
  const b = mkdtempSync(join(tmpdir(), "swarm-wt-inuse-b-"));
  try {
    const first = prepareIsolation({ id: "a", originalCwd: repo, worktreeName: "x" }, CFG, a, ADD(repo));
    equal(first.branch, "swarm/x");

    let error;
    try { prepareIsolation({ id: "b", originalCwd: repo, worktreeName: "x" }, CFG, b, ADD(repo)); }
    catch (e) { error = e; }
    ok(error, "a branch already checked out elsewhere must throw");
    ok(/checked out in another worktree/.test(error.message), error.message);
    // git reports the holder with forward slashes; the tree path is win32-native.
    ok(error.message.includes(first.path.replaceAll("\\", "/")), `the error must name the tree holding it: ${error.message}`);
  } finally {
    dropWorktree(repo, join(a, "wt-x"));
    cleanup(a, b, repo);
  }
});

// `unlandedCount` asks whether work has landed on the branch the operator is on
// NOW, not on the run's pinned base: a stale branch whose patch already reached
// the live checkout must be reusable, even though the pinned base predates it.
test("unlandedCount measures landfall against the LIVE checkout, not the pinned base", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-unlanded-"));
  const other = mkdtempSync(join(tmpdir(), "swarm-wt-unlanded2-"));
  try {
    const dispatch = git(["rev-parse", "HEAD"], repo);
    // A prior run's branch, its tree removed: the stale-branch `-B` path.
    const stale = prepareIsolation({ id: "p1", originalCwd: repo, worktreeName: "sq" }, CFG, results, ADD(repo));
    writeFileSync(join(stale.path, "sq.txt"), "squashed work\n");
    commitAll(stale.path, "sq work");
    dropWorktree(repo, stale.path);

    // That work lands on the live checkout (a squash), while the pinned base stays put.
    writeFileSync(join(repo, "sq.txt"), "squashed work\n");
    commitAll(repo, "squashed sq");
    ok(git(["rev-parse", "HEAD"], repo) !== dispatch, "precondition: the live checkout moved past the base");

    let error;
    let reused;
    try {
      reused = prepareIsolation({ id: "p2", originalCwd: repo, worktreeName: "sq" }, CFG, other,
        { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: dispatch });
    } catch (e) { error = e; }
    ok(!error, `a branch whose patch already landed on the live checkout is reusable: ${error?.message}`);
    ok(existsSync(reused.path));
  } finally { cleanup(other, results, repo); }
});
