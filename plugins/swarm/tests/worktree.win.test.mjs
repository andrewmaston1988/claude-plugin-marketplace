// The win32 half of the worktree helpers: path casing is folded there and only
// there, so both the registered-tree lookup and the run scope key need a
// case-sensitive filesystem to prove it.
//
// Its own file so the diff-aware Windows run always exercises it, not only when
// something in worktree.test.mjs's closure changed.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareIsolation, runScopeKey } from "../src/worktree.mjs";
import { initRepo, cleanup, dropWorktree, CFG, ADD } from "./helpers/worktree-fixtures.mjs";

test("prepareIsolation re-enters a registered worktree named with different case", { skip: process.platform !== "win32" && "win32-only path casing" }, async () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-CASE-"));
  const task = { id: "impl", originalCwd: repo, worktreeName: "feat" };
  try {
    const first = await prepareIsolation(task, CFG, results, ADD(repo));
    equal(first.reused, false);

    // The chain's next link, asking for the SAME tree via a differently-cased results dir.
    const swapped = results.replace(/swarm-wt-CASE-/, (m) => m.toUpperCase());
    const second = await prepareIsolation({ ...task, id: "rev" }, CFG, swapped, ADD(repo));
    equal(second.reused, true, "the second link must re-enter the tree, not re-create it");

    dropWorktree(repo, first.path);
  } finally { cleanup(repo, results); }
});

const HEXKEY = /^[0-9a-f]{12}$/;

test("runScopeKey ignores case on win32", { skip: process.platform !== "win32" && "the case rule is win32-only" }, () => {
  ok(HEXKEY.test(runScopeKey("C:\\code\\claude")));
  equal(runScopeKey("C:\\code\\claude"), runScopeKey("c:/CODE/claude"));
});
