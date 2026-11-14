import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { collect, prepareIsolation, treeDirFor } from "../src/worktree.mjs";
import { git, initRepo, cleanup, commitAll, dropWorktree, CFG, ADD } from "./helpers/worktree-fixtures.mjs";

test("collect counts every path in an untracked directory and commits ahead", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-uncommitted-"));
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: repo }, CFG, results, ADD(repo));
    writeFileSync(join(wt.path, "committed.txt"), "commit\n");
    commitAll(wt.path, "leaf commit");
    mkdirSync(join(wt.path, "new-dir", "nested"), { recursive: true });
    writeFileSync(join(wt.path, "new-dir", "nested", "a.txt"), "a\n");
    writeFileSync(join(wt.path, "new-dir", "b.txt"), "b\n");

    const result = collect({ id: "impl" }, CFG, wt);
    equal(result.kept, true);
    deepEqual(result.uncommitted, { files: 2, commitsAhead: 1 });
    ok(git(["status", "--porcelain", "--untracked-files=all"], wt.path).includes("new-dir/nested/a.txt"));
  } finally {
    dropWorktree(repo, treeDirFor(results, "impl", CFG));
    cleanup(results, repo);
  }
});

test("collect reports zero uncommitted files for a clean committed tree", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-uncommitted-"));
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: repo }, CFG, results, ADD(repo));
    writeFileSync(join(wt.path, "committed.txt"), "commit\n");
    commitAll(wt.path, "leaf commit");

    const result = collect({ id: "impl" }, CFG, wt);
    equal(result.kept, true);
    deepEqual(result.uncommitted, { files: 0, commitsAhead: 1 });
  } finally {
    dropWorktree(repo, treeDirFor(results, "impl", CFG));
    cleanup(results, repo);
  }
});
test("collect reports an unmeasured tree, not zero files, when git status cannot answer", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-uncommitted-"));
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: repo }, CFG, results, ADD(repo));
    writeFileSync(join(wt.path, "committed.txt"), "commit\n");
    commitAll(wt.path, "leaf commit");
    // A corrupt index makes every `git status` in the tree exit non-zero.
    writeFileSync(resolve(wt.path, git(["rev-parse", "--git-path", "index"], wt.path)), "not an index");

    const result = collect({ id: "impl" }, CFG, wt);
    equal(result.kept, true);
    equal(result.uncommitted.files, null, "an unanswerable status must not read as a clean tree");
    equal(result.uncommitted.commitsAhead, 1);
  } finally {
    dropWorktree(repo, treeDirFor(results, "impl", CFG));
    cleanup(results, repo);
  }
});

test("row 18: collect never asks whether a changed leaf landed", () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "status") return { status: 0, stdout: " M a.txt", stderr: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: "tree-head", stderr: "" };
    if (args[0] === "diff") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-list") return { status: 0, stdout: "1", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const wt = { branch: "swarm/leaf", repo: "/repo", path: "/tree", head: "start-head" };

  const result = collect({ id: "leaf" }, CFG, wt, { _git: runner });
  const landed = calls.filter((args) => args[0] === "for-each-ref" || args[0] === "merge-tree");
  equal(landed.length, 0, `a changed leaf must not pay for the landed check: ${JSON.stringify(landed)}`);
  equal(result.kept, true, "the changed tree is kept");
});
