// The consumer side of the tree resolver: the write guard's roots, and the tree
// NAME recovered from a recorded leaf's cwd — the one thing `swarm ask` has to
// rebuild a task from. Both used to derive a path from the run dir, which put
// them out of step with prepareIsolation the moment trees left for the scratch root.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { leafWriteGuardRoots, worktreeNameFromCwd } from "../src/manifest-task-policy.mjs";
import { treeDirFor } from "../src/worktree.mjs";
import { swarmHome } from "../src/config.mjs";

const CFG = { worktreeBranchPrefix: "swarm/" };
// Runs filed the way the CLI files them — under <swarmHome>/runs/<encoded>/<run> —
// because the resolver inverts that two-level tail to find the run again.
const runDir = (name) => join(swarmHome(), "runs", "C--code-repo", name);
const treesDir = () => mkdtempSync(join(tmpdir(), "swarm-consumers-"));
const cfgWith = (treeRoot) => ({ ...CFG, treeRoot });

function writeRecord(resultsDir, rec) {
  mkdirSync(join(resultsDir, "trees"), { recursive: true });
  writeFileSync(join(resultsDir, "trees", `${rec.name}.json`), JSON.stringify(rec));
}

test("leafWriteGuardRoots: the tree root is the resolved tree, never a wt- dir in the run", () => {
  const results = runDir("run-guard");
  const root = treesDir();
  try {
    const roots = leafWriteGuardRoots({ worktreeName: "impl", resultsDir: results, cfg: cfgWith(root) });
    equal(roots.length, 1);
    equal(roots[0], treeDirFor(results, "impl", cfgWith(root)));
    ok(!roots[0].startsWith(resolve(results)),
      "a guard rooted at a path the scheduler never creates denies every write the leaf makes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("leafWriteGuardRoots: a recorded tree wins over the formula, so a resumed run stays writable", () => {
  const results = runDir("run-guard-rec");
  const root = treesDir();
  const moved = join(root, "somewhere-else", "impl");
  try {
    writeRecord(results, { name: "impl", path: moved, branch: "swarm/impl", repo: "/repo", state: "ready" });
    equal(leafWriteGuardRoots({ worktreeName: "impl", resultsDir: results, cfg: cfgWith(root) })[0], resolve(moved),
      "the guard must point where the tree actually is, whatever treeRoot says now");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("leafWriteGuardRoots: outputDir is still a second root, and no tree means no first one", () => {
  const results = runDir("run-guard-out");
  const root = treesDir();
  try {
    const both = leafWriteGuardRoots({ worktreeName: "impl", resultsDir: results, outputDir: "/live/artefacts", cfg: cfgWith(root) });
    equal(both.length, 2);
    equal(both[1], "/live/artefacts");
    equal(leafWriteGuardRoots({ resultsDir: results, outputDir: "/live/artefacts", cfg: cfgWith(root) }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worktreeNameFromCwd: a cwd under treeRoot names its tree", () => {
  const results = runDir("run-name");
  const root = treesDir();
  try {
    const tree = treeDirFor(results, "fix-0", cfgWith(root));
    equal(worktreeNameFromCwd(tree, results, cfgWith(root)), "fix-0");
    equal(worktreeNameFromCwd(join(tree, "sub"), results, cfgWith(root)), "fix-0",
      "a writer sits at its declared depth inside its tree — the tree is still the same tree");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worktreeNameFromCwd: the record outranks the formula — a clone's id is not its tree name", () => {
  const results = runDir("run-name-rec");
  const root = treesDir();
  const moved = join(root, "moved", "fix-0");
  try {
    writeRecord(results, { name: "fix-0", path: moved, branch: "swarm/fix-0", repo: "/repo", state: "ready" });
    equal(worktreeNameFromCwd(moved, results, cfgWith(root)), "fix-0",
      "rebuilding the ask task from the formula would name a tree that never existed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worktreeNameFromCwd: a legacy <run>/wt-<name> tree still names its tree", () => {
  const results = runDir("run-name-legacy");
  try {
    equal(worktreeNameFromCwd(join(results, "wt-impl"), results, CFG), "impl",
      "a pre-upgrade run has no records, and its tree is the only thing that says which one it is");
    equal(worktreeNameFromCwd(join(results, "wt-impl", "sub"), results, CFG), "impl",
      "a legacy leaf's cwd sits at its declared depth inside the tree, same as a new-layout one");
    equal(worktreeNameFromCwd(join(results, "results"), results, CFG), undefined,
      "a run dir's other children are not trees");
  } finally { rmSync(results, { recursive: true, force: true }); }
});

test("worktreeNameFromCwd: nothing outside this run's trees is a name", () => {
  const results = runDir("run-name-none");
  const root = treesDir();
  try {
    equal(worktreeNameFromCwd(join(tmpdir(), "swarm-live-repo"), results, cfgWith(root)), undefined,
      "a reader in the live repo has no tree");
    equal(worktreeNameFromCwd(join(root, "C--code-repo", "run-other", "impl"), results, cfgWith(root)), undefined,
      "a sibling run's tree is not this run's leaf");
    equal(worktreeNameFromCwd("", results, cfgWith(root)), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
