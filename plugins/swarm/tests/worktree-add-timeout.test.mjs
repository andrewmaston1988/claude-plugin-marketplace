import { test } from "node:test";
import { ok } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareIsolation } from "../src/worktree.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

test("prepareIsolation names a worktree-add timeout caused by a slow reference hook", { timeout: 15000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-wt-repo-"));
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  const hooks = mkdtempSync(join(tmpdir(), "swarm-wt-hooks-"));
  const git = (...args) => spawnSync("git", args, { cwd: repo, windowsHide: true });
  try {
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(join(hooks, "reference-transaction"), '#!/bin/sh\nnode -e "setTimeout(() => {}, 2000)"\n', { mode: 0o755 });
    git("config", "core.hooksPath", hooks);
    let error;
    try {
      prepareIsolation({ id: "slow", originalCwd: repo }, CFG, resultsDir, { addTimeoutMs: 100 });
    } catch (e) { error = e; }
    ok(error, "the timed-out add throws");
    ok(/timed out after/.test(error.message), error.message);
  } finally {
    // Killing git leaves the hook alive holding the repo as cwd; Windows refuses the delete until it exits.
    const until = Date.now() + 10000;
    while (!existsSync(join(hooks, "done")) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    for (const d of [resultsDir, hooks, repo]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
