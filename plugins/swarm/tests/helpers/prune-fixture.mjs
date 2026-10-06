// Fixtures shared by the prune tests in cli-prune.test.mjs and the two stop/prune
// sweeps left in cli.test.mjs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitAll, gitOut, tmp } from "./cli-fixture.mjs";

// A real tiny repo + a real worktree, used to exercise prune end-to-end.
export function initPruneRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-cli-repo-"));
  spawnSync("git", ["init", "-q", "-b", "master"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  commitAll(repo, "init");
  return repo;
}

// A run record finished BEFORE the summary was written (so run.log's mtime
// never outgrows summary.json's) — the exact ordering runLiveness trusts.
export function writeFinishedRun(resultsDir, worktreesKept) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001" }] }) + "\n");
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify({
    started: new Date().toISOString(),
    finished: new Date().toISOString(),
    tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001", state: "ok" }],
    blocked: [],
    worktreesKept,
    totalTokens: null,
  }));
}

// A real repo plus a resultsDir holding a tree the run never summarised. The run's
// repo signal is manifest.json's cwd: the snapshot refs and the run.log `snapshot`
// events that used to name the repo are gone, so a fixture without a manifest is a
// fixture prune cannot resolve.
export function pruneFixture() {
  const repo = initPruneRepo();
  const dir = tmp();
  const resultsDir = join(dir, "out");
  mkdirSync(resultsDir, { recursive: true });
  const sha = gitOut(["rev-parse", "HEAD"], repo);
  writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
  return { repo, dir, resultsDir, sha, tree: join(resultsDir, "wt-impl") };
}

// A detached tree is what a killed `worktree add` leaves: no branch, so prune's
// branchless removal path is the one under test.
export function addDetachedTree(f, repo = f.repo, tree = f.tree, sha = f.sha) {
  spawnSync("git", ["worktree", "add", "--detach", tree, sha], { cwd: repo, windowsHide: true });
}

export function writeKilledRun(f) {
  const line = (o) => JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n";
  writeFileSync(join(f.resultsDir, "run.log"),
    line({ event: "run-start", tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001" }] }) +
    line({ event: "run-aborted", reason: "killed" }));
}

export const dropSnapPrune = (f) => {
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
};
