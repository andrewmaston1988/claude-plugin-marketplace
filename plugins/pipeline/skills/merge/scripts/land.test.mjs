import "../../../tests/helpers/isolate-home.mjs";
import { equal, match } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pushTarget } from "./land.mjs";
import { runGit } from "./rebase.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "merge-land-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = join(tmp, "repo");
  const origin = join(tmp, "origin.git");
  const pushRepo = join(tmp, "push.git");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.hooksPath", join(tmp, "no-hooks"));
  git(repo, "commit", "--allow-empty", "-m", "Seed");
  git(tmp, "clone", "--bare", repo, origin);
  git(tmp, "clone", "--bare", repo, pushRepo);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "switch", "-c", "feature");
  git(repo, "commit", "--allow-empty", "-m", "Feature");
  const errors = [];
  const logger = { log: () => {}, err: (message) => errors.push(message) };
  return { repo, origin, pushRepo, errors, logger };
}

test("pushTarget pushes HEAD even when the local target names another commit", (t) => {
  const { repo, origin, logger } = fixture(t);
  equal(pushTarget(repo, "main", logger), true);
  equal(git(origin, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));
});

test("pushTarget fails when the push succeeds but the fetch-side origin still lacks HEAD", (t) => {
  const { repo, origin, pushRepo, errors, logger } = fixture(t);
  const before = git(origin, "rev-parse", "main");
  git(repo, "remote", "set-url", "--push", "origin", pushRepo);

  equal(pushTarget(repo, "main", logger), false);
  equal(git(pushRepo, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));
  equal(git(origin, "rev-parse", "main"), before);
  match(errors[0], /BLOCKER: push/);
});

test("pushTarget accepts a newer origin commit that contains HEAD", (t) => {
  const { repo, origin, pushRepo, errors, logger } = fixture(t);
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "--allow-empty", "-m", "Advance origin");
  git(repo, "branch", "-f", "main", "HEAD");
  git(repo, "push", "origin", "main");
  git(repo, "reset", "--hard", head);
  git(repo, "remote", "set-url", "--push", "origin", pushRepo);

  equal(pushTarget(repo, "main", logger), true);
  equal(errors.length, 0);
});

test("pushTarget verifies the pushed commit even when local HEAD moves during fetch", (t) => {
  const { repo, origin, logger } = fixture(t);
  const pushed = git(repo, "rev-parse", "HEAD");

  equal(pushTarget(repo, "main", {
    ...logger,
    git(args, cwd, opts) {
      if (args[0] === "fetch") git(cwd, "commit", "--allow-empty", "-m", "Move local HEAD");
      return runGit(args, cwd, opts);
    },
  }), true);
  equal(git(origin, "rev-parse", "main"), pushed);
});
