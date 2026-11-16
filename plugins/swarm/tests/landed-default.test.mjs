import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { landedOnDefault } from "../src/landed.mjs";
import { initRepo } from "./helpers/worktree-fixtures.mjs";
import { git, must, writeCommit } from "./helpers/port-fixture.mjs";

const OPTS = { prefix: "swarm/", gitRunner: git };

function withRepo(fn) {
  const repo = initRepo();
  try { return fn(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
}

test("row 8: landedOnDefault is true for a commit the default branch contains", () => withRepo((repo) => {
  writeCommit(repo, "a.txt", "main work\n", "main work");
  const tip = must(["rev-parse", "HEAD"], repo);

  equal(landedOnDefault(tip, repo, OPTS), true);
}));

test("row 8: landedOnDefault is true for a commit the default branch absorbs", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "swarm/leaf", "main"], repo);
  writeCommit(repo, "a.txt", "leaf a\n", "leaf a");
  writeCommit(repo, "b.txt", "leaf b\n", "leaf b");
  const laneTip = must(["rev-parse", "HEAD"], repo);
  must(["checkout", "-q", "main"], repo);
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash leaf"], repo);
  ok(must(["rev-parse", "HEAD"], repo) !== laneTip, "precondition: the squash is a new commit");

  equal(landedOnDefault(laneTip, repo, OPTS), true);
}));

test("row 8: a commit only a non-default local ref holds is not landed", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "feat", "main"], repo);
  writeCommit(repo, "feat.txt", "feat work\n", "feat work");
  const featTip = must(["rev-parse", "HEAD"], repo);
  must(["checkout", "-q", "main"], repo);

  equal(landedOnDefault(featTip, repo, OPTS), false);
}));

test("row 13(a): a branch pushed but never merged is not landed", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "feat", "main"], repo);
  writeCommit(repo, "feat.txt", "feat work\n", "feat work");
  const featTip = must(["rev-parse", "HEAD"], repo);
  // The ref a push leaves once the branch is deleted locally.
  must(["update-ref", "refs/remotes/origin/feat", featTip], repo);
  must(["checkout", "-q", "main"], repo);
  must(["branch", "-q", "-D", "feat"], repo);
  ok(must(["for-each-ref", "--contains", featTip, "--format=%(refname)"], repo).includes("refs/remotes/origin/feat"),
    "precondition: a remote-tracking ref is the only thing holding the commit");

  equal(landedOnDefault(featTip, repo, OPTS), false);
}));
