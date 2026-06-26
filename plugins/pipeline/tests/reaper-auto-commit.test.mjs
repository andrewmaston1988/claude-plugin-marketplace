// Tests for autoCommitWorktree — the reaper helper that stages and commits
// any uncommitted work sitting in a feature worktree before the dev-no-handoff
// recovery decision. See reaper.mjs:autoCommitWorktree.
//
// All cases drive the helper against real temp git repos (no mocks): the
// helper is pure I/O against `git`, so mocking would test the mock.

import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { autoCommitWorktree } from "../src/orchestrator/reaper.mjs";

const TS = "2026-06-16T040100Z";
const FEATURE = "reaper-auto-commit-test";

function silentLog() { /* no-op; capture via injected logFn per test */ }

function makeRepo() {
  // Bare-bones git repo: init, configure a committer, commit one file on
  // master so HEAD is valid and the worktree path is real.
  const root = mkdtempSync(join(tmpdir(), "reaper-autocommit-"));
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  run(["init", "--initial-branch=master", "-q"]);
  run(["config", "user.email", "test@test"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "README.md"), "init\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "init"]);
  return { root, run };
}

function makeBranchRepo(branch) {
  const repo = makeRepo();
  repo.run(["checkout", "-q", "-b", branch]);
  return repo;
}

test("autoCommitWorktree: worktree path does not exist → returns false, no log", () => {
  const logs = [];
  const logFn = (msg, level) => logs.push({ msg, level });
  const result = autoCommitWorktree("/nonexistent/path/that/cannot/exist", FEATURE, TS, logFn);
  strictEqual(result, false);
  strictEqual(logs.length, 0, "should not log when worktree is absent");
});

test("autoCommitWorktree: path exists but is not a git worktree → returns false, no log", () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-autocommit-"));
  try {
    const logs = [];
    const result = autoCommitWorktree(dir, FEATURE, TS, (msg, level) => logs.push({ msg, level }));
    strictEqual(result, false);
    strictEqual(logs.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoCommitWorktree: clean worktree (no changes) → returns false, no commit log", () => {
  const { root, run } = makeBranchRepo("autonomous/" + FEATURE);
  try {
    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level });
    const result = autoCommitWorktree(root, FEATURE, TS, logFn);
    strictEqual(result, false, "no work to commit → false");
    // No 'committed' log emitted when status was empty.
    ok(
      !logs.some(l => l.msg.includes("committed worktree changes")),
      "should not log a successful commit when status was clean"
    );
    // HEAD still at the initial commit.
    const log = run(["rev-list", "--count", "HEAD"]);
    strictEqual(log.stdout.trim(), "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autoCommitWorktree: untracked + modified files → commits them, logs WARN, HEAD advances", () => {
  const { root, run } = makeBranchRepo("autonomous/" + FEATURE);
  try {
    // Untracked file + modified tracked file.
    writeFileSync(join(root, "new-file.txt"), "wip content\n");
    writeFileSync(join(root, "README.md"), "modified\n");
    // Untracked dir with content (exercises `add -A`).
    mkdirSync(join(root, "subdir"));
    writeFileSync(join(root, "subdir", "nested.txt"), "nested\n");

    const logs = [];
    const logFn = (msg, level) => logs.push({ msg, level });

    const result = autoCommitWorktree(root, FEATURE, TS, logFn);
    strictEqual(result, true, "should return true after committing");

    // Status should now be clean.
    const status = run(["status", "--porcelain"]);
    strictEqual(status.stdout.trim(), "", "worktree should be clean after auto-commit");

    // HEAD should have advanced by 1 commit with our message.
    const log = run(["log", "-1", "--format=%s"]);
    ok(
      log.stdout.includes("wip: reaper auto-commit") && log.stdout.includes(TS),
      `commit message should include wip prefix and ts; got: ${log.stdout}`
    );

    // Author/committer should be the reaper identity.
    const author = run(["log", "-1", "--format=%an <%ae>"]);
    strictEqual(author.stdout.trim(), "Pipeline Reaper <reaper@pipeline>");

    // The committed log entry should be WARN.
    const commitLog = logs.find(l => l.msg.includes("committed worktree changes"));
    ok(commitLog, "expected a 'committed worktree changes' log line");
    strictEqual(commitLog.level, "WARN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autoCommitWorktree: nothing staged but staged-only change → still commits", () => {
  // Edge: user already ran `git add` but did not commit. `add -A` is idempotent
  // on the staged set; we should still produce a commit.
  const { root, run } = makeBranchRepo("autonomous/" + FEATURE);
  try {
    writeFileSync(join(root, "staged-only.txt"), "staged content\n");
    run(["add", "staged-only.txt"]);

    const result = autoCommitWorktree(root, FEATURE, TS, silentLog);
    strictEqual(result, true);

    const status = run(["status", "--porcelain"]);
    strictEqual(status.stdout.trim(), "", "should be clean after auto-commit");

    const log = run(["log", "-1", "--format=%s"]);
    ok(log.stdout.includes("wip: reaper auto-commit"), `got: ${log.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
