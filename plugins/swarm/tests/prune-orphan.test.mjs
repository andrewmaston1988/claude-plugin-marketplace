// A run dispatched from a temporary worktree outlives it: once that tree is removed
// the manifest's cwd resolves to nothing, and prune used to report "nothing to prune"
// while git still registered every leaf tree (scout, 2026-09-24). The trees
// themselves still know their repo.
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

test("prune finds a run's leaf trees when the manifest's cwd worktree is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-prune-orphan-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "master"], repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], repo);
  try {
    const base = join(root, "staging-base");
    git(["worktree", "add", "-q", "--detach", base], repo);
    const resultsDir = join(root, "run-1");
    mkdirSync(resultsDir);
    const leaf = join(resultsDir, "wt-impl");
    git(["worktree", "add", "-q", "-b", "swarm/x/impl", leaf], repo);
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ cwd: base, tasks: [{ id: "impl" }] }));
    writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start" }) + "\n");
    writeFileSync(join(resultsDir, "summary.json"), JSON.stringify({ started: new Date().toISOString(), finished: new Date().toISOString(), tasks: [], blocked: [], worktreesKept: [], totalTokens: null }));
    git(["worktree", "remove", "--force", base], repo);

    const dry = runCli(["prune", resultsDir, "--dry-run"], { cwd: root, env: { SWARM_HOME: join(root, "home") } });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    ok(dry.stdout.includes("swarm/x/impl"), dry.stdout);

    const real = runCli(["prune", resultsDir], { cwd: root, env: { SWARM_HOME: join(root, "home") } });
    equal(real.status, 0, real.stdout + real.stderr);
    ok(!existsSync(leaf), "the leaf tree is removed");
    ok(!git(["worktree", "list"], repo).stdout.includes("wt-impl"), "and unregistered from git");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
