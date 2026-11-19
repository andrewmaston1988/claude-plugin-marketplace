// Fixtures shared by the prune tests in cli-prune.test.mjs and the two stop/prune
// sweeps left in cli.test.mjs.
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { commitAll, gitOut, tmp } from "./cli-fixture.mjs";
import { treeDirFor } from "../../src/worktree.mjs";
import { templateRepo } from "./template-repo.mjs";

// A real tiny repo + a real worktree, used to exercise prune end-to-end.
export function initPruneRepo() {
  return templateRepo("prune", (repo) => {
    spawnSync("git", ["init", "-q", "-b", "master"], { cwd: repo, windowsHide: true });
    writeFileSync(join(repo, "a.txt"), "hello\n");
    commitAll(repo, "init");
  });
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
  // The repo that ENCLOSES treeRoot (`tmp()`'s own git repo) is left explicitly dirty: a
  // prune that runs git inside an unlinked tree measures THIS repo's files as the row's
  // uncommitted work, so the wrong-repo count has to be visible in every row.
  writeFileSync(join(dir, "parent-dirty-a.txt"), "parent\n");
  writeFileSync(join(dir, "parent-dirty-b.txt"), "parent\n");
  return { repo, dir, resultsDir, sha, tree: treeDirFor(resultsDir, "impl", { treeRoot: join(dir, "home", "worktrees") }) };
}

// The half-failed prune's leftover: git unregistered the tree, removed its contents and
// deleted the branch, but the directory itself survived with no `.git` link. The record
// prepareIsolation wrote is the run's own memory of which repo the tree belonged to.
export function unlinkedTree(f, { name = "impl", branch = "swarm/impl", contents = [] } = {}) {
  const tree = treeDirFor(f.resultsDir, name, { treeRoot: join(f.dir, "home", "worktrees") });
  mkdirSync(join(f.resultsDir, "trees"), { recursive: true });
  writeFileSync(join(f.resultsDir, "trees", `${name}.json`),
    JSON.stringify({ name, path: tree, branch, repo: f.repo, state: "ready" }));
  mkdirSync(tree, { recursive: true });
  for (const file of contents) writeFileSync(join(tree, file), "");
  return tree;
}

// The same leftover while git still has it registered: a real worktree whose `.git` file
// and contents are gone. `git worktree prune` is the only thing that can drop the entry.
export function unlinkedRegisteredTree(f, { name = "impl", contents = [] } = {}) {
  const tree = treeDirFor(f.resultsDir, name, { treeRoot: join(f.dir, "home", "worktrees") });
  spawnSync("git", ["worktree", "add", "-q", "-b", `swarm/${name}`, tree, f.sha], { cwd: f.repo, windowsHide: true });
  rmSync(join(tree, ".git"), { force: true });
  for (const entry of readdirSync(tree)) rmSync(join(tree, entry), { recursive: true, force: true });
  for (const file of contents) writeFileSync(join(tree, file), "");
  return tree;
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
