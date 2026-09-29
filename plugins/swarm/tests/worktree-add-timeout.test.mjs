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
    const done = join(hooks, "done").replaceAll("\\", "/");
    writeFileSync(join(hooks, "reference-transaction"), `#!/bin/sh\nnode -e "setTimeout(() => require('fs').writeFileSync('${done}', ''), 2000)"\n`, { mode: 0o755 });
    git("config", "core.hooksPath", hooks);
    let error;
    try {
      prepareIsolation({ id: "slow", originalCwd: repo }, CFG, resultsDir, { addTimeoutMs: 100 });
    } catch (e) { error = e; }
    ok(error, "the timed-out add throws");
    ok(/timed out after/.test(error.message), error.message);
  } finally {
    // Killing git leaves hooks alive holding the repo as cwd; wait for the first hook's marker, then retry the delete until the chained ones exit.
    const until = Date.now() + 10000;
    while (!existsSync(join(hooks, "done")) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    for (const d of [resultsDir, hooks, repo]) {
      for (const stop = Date.now() + 10000; ; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)) {
        try { rmSync(d, { recursive: true, force: true }); break; } catch (e) { if (Date.now() > stop) throw e; }
      }
    }
  }
});

test("prepareIsolation requires addTimeoutMs and names it in the error", () => {
  for (const opts of [undefined, {}, { addTimeoutMs: 0 }, { addTimeoutMs: "5" }]) {
    let error;
    try { prepareIsolation({ id: "x", originalCwd: "." }, CFG, ".", opts); } catch (e) { error = e; }
    ok(error, `throws for ${JSON.stringify(opts)}`);
    ok(/addTimeoutMs/.test(error.message), error.message);
  }
});
