import "./helpers/isolate-home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { templateRepo } from "./helpers/template-repo.mjs";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return (result.stdout || "").trim();
}

function buildRepo(repo) {
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], repo);
}

test("S3 template copies are independent and reject linked worktrees", () => {
  const first = templateRepo("s3-independent", buildRepo);
  const second = templateRepo("s3-independent", buildRepo);
  const initial = git(["rev-parse", "HEAD"], first);
  assert.equal(git(["rev-parse", "HEAD"], second), initial);
  writeFileSync(join(first, "change.txt"), "change\n");
  git(["add", "."], first);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change"], first);
  assert.notEqual(git(["rev-parse", "HEAD"], first), initial);
  assert.equal(git(["rev-parse", "HEAD"], second), initial);
  const third = templateRepo("s3-independent", buildRepo);
  assert.equal(git(["rev-parse", "HEAD"], third), initial);

  const linked = templateRepo("s3-worktree", buildRepo);
  const linkedPath = mkdtempSync(join(tmpdir(), "swarm-s3-worktree-"));
  git(["worktree", "add", "-q", "-b", "linked", linkedPath], linked);
  assert.equal((git(["worktree", "list", "--porcelain"], linked).match(/^worktree /gm) || []).length, 2);
  assert.equal((git(["worktree", "list", "--porcelain"], third).match(/^worktree /gm) || []).length, 1);
  assert.throws(() => templateRepo("s3-refuse-linked", (repo) => {
    buildRepo(repo);
    git(["worktree", "add", "-q", "-b", "linked", mkdtempSync(join(tmpdir(), "swarm-s3-invalid-"))], repo);
  }), /plain repository/);
});
