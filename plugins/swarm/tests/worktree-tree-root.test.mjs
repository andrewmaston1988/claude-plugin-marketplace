// Where a run's leaf trees live, and how the run remembers it: `treeRoot`, the
// record-aware resolver, and the write-ahead `<run>/trees/<name>.json` record.
//
// Split from worktree.test.mjs rather than appended to it: that file is already
// over the file-size ratchet's 500-line ceiling, so it may not grow.
import { after, test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import {
  prepareIsolation, collect, treeDirFor, runOfTree, treeRootFor,
  readTreeRecord, listTreeRecords, legacyTreeDirs, WORKTREE_ADD_TIMEOUT_MS,
} from "../src/worktree.mjs";
import { swarmHome } from "../src/config.mjs";
import { git, initRepo, cleanup, commitAll, dropWorktree, CFG, ADD } from "./helpers/worktree-fixtures.mjs";

// A run dir in the REAL shape — under <swarmHome>/runs/<encoded>/<run> — because
// runOfTree can only invert the formula against the runs root it was built from.
const previousHome = process.env.SWARM_HOME;
const ownedHome = mkdtempSync(join(tmpdir(), "swarm-tree-root-home-"));
process.env.SWARM_HOME = ownedHome;
after(() => {
  if (previousHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = previousHome;
  cleanup(ownedHome);
});
const runDir = (name) => join(swarmHome(), "runs", "C--code-repo", name);
const recordPath = (resultsDir, name) => join(resultsDir, "trees", `${name}.json`);
// A cfg whose trees land somewhere the test owns, so nothing touches the real
// home and two runs of one test cannot collide.
const cfgWith = (treeRoot) => ({ ...CFG, treeRoot });
const treesDir = () => mkdtempSync(join(tmpdir(), "swarm-trees-"));

test("treeRootFor defaults to <swarmHome>/worktrees and honours cfg.treeRoot", () => {
  equal(treeRootFor({}), resolve(join(swarmHome(), "worktrees")), "the shipped default follows SWARM_HOME");
  equal(treeRootFor({ treeRoot: join(tmpdir(), "elsewhere") }), resolve(join(tmpdir(), "elsewhere")),
    "an operator-set treeRoot wins");
});

test("treeDirFor places a tree under treeRoot/<project>/<run>/<name>, never under the run dir", () => {
  const results = runDir("run-1");
  const root = treesDir();
  try {
    equal(treeDirFor(results, "impl", cfgWith(root)),
      resolve(join(root, "C--code-repo", "run-1", "impl")));
    ok(!treeDirFor(results, "impl", cfgWith(root)).startsWith(resolve(results)),
      "trees must not sit inside the run dir — that is the whole point of the scratch root");
  } finally { cleanup(root); }
});

test("runOfTree is treeDirFor's inverse for a new-layout tree, and the run dir for a legacy one", () => {
  const results = runDir("run-1");
  const root = treesDir();
  try {
    equal(runOfTree(treeDirFor(results, "impl", cfgWith(root)), cfgWith(root)), resolve(results),
      "a tree under treeRoot resolves back to its run");
    equal(runOfTree(join(results, "wt-impl"), cfgWith(root)), resolve(results),
      "a legacy <run>/wt-<name> tree still resolves to its run dir");
  } finally { cleanup(root); }
});

test("prepareIsolation creates the tree under treeRoot, not inside the run dir", () => {
  const repo = initRepo();
  const results = runDir("run-create");
  const root = treesDir();
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cfgWith(root), results, ADD(repo));
    equal(wt.path, resolve(join(root, "C--code-repo", "run-create", "impl")));
    ok(existsSync(join(wt.path, "a.txt")), "the tree is a real checkout");
    ok(!existsSync(join(results, "wt-impl")), "no wt- dir is left in the run dir");
  } finally {
    dropWorktree(repo, resolve(join(root, "C--code-repo", "run-create", "impl")));
    cleanup(root, results, repo);
  }
});

test("prepareIsolation records the tree — 'ready' after the add, with name/path/branch/repo", () => {
  const repo = initRepo();
  const results = runDir("run-record");
  const root = treesDir();
  let wt;
  try {
    wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cfgWith(root), results, ADD(repo));
    const rec = readTreeRecord(results, "impl");
    ok(rec, "the run must record where it put the tree");
    equal(rec.state, "ready");
    equal(rec.name, "impl");
    equal(rec.path, wt.path);
    equal(rec.branch, "swarm/impl");
    equal(rec.repo, repo);
  } finally {
    dropWorktree(repo, wt.path);
    cleanup(root, results, repo);
  }
});

test("the record is written BEFORE the add: a failed add still leaves a 'creating' record", () => {
  const repo = initRepo();
  const results = runDir("run-crash");
  const root = treesDir();
  try {
    let threw = null;
    try {
      prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cfgWith(root), results,
        { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: "0000000000000000000000000000000000000000" });
    } catch (e) { threw = e; }
    ok(threw, "an unresolvable base must fail the add");
    const rec = readTreeRecord(results, "impl");
    ok(rec, "a crash between record and add must never leave an UNRECORDED tree — prune resolves the record");
    equal(rec.state, "creating");
    equal(rec.path, resolve(join(root, "C--code-repo", "run-crash", "impl")));
  } finally { cleanup(root, results, repo); }
});

test("the resolver reuses a legacy <run>/wt-<name> tree that is still registered", () => {
  const repo = initRepo();
  const results = runDir("run-legacy");
  const root = treesDir();
  const legacy = join(results, "wt-impl");
  try {
    mkdirSync(results, { recursive: true });
    git(["worktree", "add", legacy, "-b", "swarm/impl"], repo);
    ok(existsSync(join(legacy, "a.txt")), "legacy tree registered");
    writeFileSync(join(legacy, "partial.txt"), "kept work\n");

    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cfgWith(root), results, ADD(repo));
    equal(wt.path, resolve(legacy), "resuming a legacy run must re-enter its tree, not compute the new path");
    equal(wt.reused, true);
    ok(existsSync(join(wt.path, "partial.txt")), "the legacy tree's work survives the resume");
  } finally {
    dropWorktree(repo, legacy);
    cleanup(root, results, repo);
  }
});

test("the record outranks the legacy scan and the formula — a moved tree is still found", () => {
  const repo = initRepo();
  const results = runDir("run-moved");
  const root = treesDir();
  const moved = join(root, "somewhere-else", "impl");
  try {
    mkdirSync(results, { recursive: true });
    mkdirSync(dirname(moved), { recursive: true });
    git(["worktree", "add", moved, "-b", "swarm/impl"], repo);
    ok(existsSync(join(moved, "a.txt")), "tree registered off the formula");
    mkdirSync(join(results, "trees"), { recursive: true });
    writeFileSync(recordPath(results, "impl"),
      JSON.stringify({ name: "impl", path: moved, branch: "swarm/impl", repo, state: "ready" }));

    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cfgWith(root), results, ADD(repo));
    equal(wt.path, resolve(moved), "the record is authoritative — recomputing would point at a tree that does not exist");
  } finally {
    dropWorktree(repo, moved);
    cleanup(root, results, repo);
  }
});

test("a branch held by another run's tree names that RUN dir, not the tree under treeRoot", () => {
  const repo = initRepo();
  const runA = runDir("run-holder-a");
  const runB = runDir("run-holder-b");
  const root = treesDir();
  let first;
  try {
    first = prepareIsolation({ id: "x", originalCwd: repo, cwd: repo }, cfgWith(root), runA, ADD(repo));
    let error = null;
    try { prepareIsolation({ id: "x", originalCwd: repo, cwd: repo }, cfgWith(root), runB, ADD(repo)); }
    catch (e) { error = e; }
    ok(error, "a branch already checked out elsewhere must throw");
    equal(error.message.match(/swarm prune ([^)]+)\)/)?.[1], resolve(runA).replaceAll("\\", "/"),
      "the tree is no longer the run dir's child — dirname() would hand prune a path with no run.log");
  } finally {
    if (first) dropWorktree(repo, first.path);
    cleanup(root, runA, runB, repo);
  }
});

test("two concurrent writer leaves in one run each leave their own record", async () => {
  const repo = initRepo();
  const results = runDir("run-concurrent");
  const root = treesDir();
  const base = ADD(repo).base;
  const worktreeModule = new URL("../src/worktree.mjs", import.meta.url).href;
  const childSource = `
    const [moduleUrl, repo, results, root, name, base] = process.argv.slice(1);
    const { prepareIsolation, WORKTREE_ADD_TIMEOUT_MS } = await import(moduleUrl);
    const cfg = { worktreeBranchPrefix: "swarm/", treeRoot: root };
    prepareIsolation({ id: name, originalCwd: repo, cwd: repo }, cfg, results,
      { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base });
  `;
  const paths = ["alpha", "beta"].map((name) => treeDirFor(results, name, cfgWith(root)));
  const runChild = (name) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource,
      worktreeModule, repo, results, root, name, base], { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => code === 0 ? resolvePromise() :
      rejectPromise(new Error(`writer ${name} exited ${code}: ${stderr}`)));
  });
  try {
    await Promise.all([runChild("alpha"), runChild("beta")]);
    deepEqual(readdirSync(join(results, "trees")).sort(), ["alpha.json", "beta.json"],
      "concurrent writers must not overwrite or lose one another's records");
    for (const name of ["alpha", "beta"]) {
      equal(readTreeRecord(results, name)?.state, "ready");
      ok(existsSync(join(treeDirFor(results, name, cfgWith(root)), "a.txt")),
        `${name} has its own checked out tree`);
    }
  } finally {
    for (const path of paths) dropWorktree(repo, path);
    cleanup(root, results, repo);
  }
});
test("two writer leaves in one run each get their own record file", () => {
  const repo = initRepo();
  const results = runDir("run-two");
  const root = treesDir();
  const paths = [];
  try {
    for (const name of ["alpha", "beta"]) {
      paths.push(prepareIsolation({ id: name, originalCwd: repo, cwd: repo }, cfgWith(root), results, ADD(repo)).path);
    }
    equal(paths[0] === paths[1], false, "distinct names are distinct trees");
    deepEqual(readdirSync(join(results, "trees")).sort(), ["alpha.json", "beta.json"],
      "one file per tree — a shared file is a read-modify-write race between concurrent leaves");
    equal(readTreeRecord(results, "alpha").name, "alpha");
    equal(readTreeRecord(results, "beta").name, "beta");
    equal(listTreeRecords(results).length, 2);
  } finally {
    for (const p of paths) dropWorktree(repo, p);
    cleanup(root, results, repo);
  }
});

test("listTreeRecords tolerates a half-written or malformed record instead of throwing", () => {
  const results = runDir("run-junk");
  try {
    mkdirSync(join(results, "trees"), { recursive: true });
    writeFileSync(recordPath(results, "good"), JSON.stringify({ name: "good", path: "/x", state: "ready" }));
    writeFileSync(recordPath(results, "junk"), "{not json");
    const recs = listTreeRecords(results);
    equal(recs.length, 1, "a malformed record is skipped, not fatal — discovery must not die on one bad file");
    equal(recs[0].name, "good");
    equal(readTreeRecord(results, "junk"), null);
  } finally { cleanup(results); }
});

test("legacyTreeDirs finds the wt-* trees a pre-upgrade run left in its run dir", () => {
  const results = runDir("run-legacyscan");
  try {
    mkdirSync(join(results, "wt-feat"), { recursive: true });
    mkdirSync(join(results, "wt-other"), { recursive: true });
    mkdirSync(join(results, "results"), { recursive: true });
    deepEqual(legacyTreeDirs(results).map((t) => t.name).sort(), ["feat", "other"]);
    deepEqual(legacyTreeDirs(results).map((t) => resolve(t.path)).sort(),
      [join(results, "wt-feat"), join(results, "wt-other")].map((p) => resolve(p)).sort());
  } finally { cleanup(results); }
});

test("collect drops the record of a swept tree, and keeps the record of a kept one", () => {
  const repo = initRepo();
  const results = runDir("run-collect");
  const root = treesDir();
  try {
    const task = { id: "noop", originalCwd: repo, cwd: repo };
    const wt = prepareIsolation(task, cfgWith(root), results, ADD(repo));
    collect(task, cfgWith(root), wt);
    equal(readTreeRecord(results, "noop"), null,
      "a swept tree's record must go too — a stale 'ready' path is a tree prune would try to delete twice");

    const keep = { id: "edit", originalCwd: repo, cwd: repo };
    const wt2 = prepareIsolation(keep, cfgWith(root), results, ADD(repo));
    writeFileSync(join(wt2.path, "new.txt"), "work\n");
    equal(collect(keep, cfgWith(root), wt2).kept, true);
    equal(readTreeRecord(results, "edit").state, "ready", "a kept tree stays recorded");
  } finally {
    dropWorktree(repo, resolve(join(root, "C--code-repo", "run-collect", "edit")));
    cleanup(root, results, repo);
  }
});

test("a record naming a tree that is gone is still honoured, and the tree is re-created there", () => {
  const repo = initRepo();
  const results = runDir("run-stale");
  const root = treesDir();
  const stale = join(root, "C--code-repo", "run-stale", "relocated", "impl");
  try {
    mkdirSync(join(results, "trees"), { recursive: true });
    writeFileSync(recordPath(results, "impl"),
      JSON.stringify({ name: "impl", path: stale, branch: "swarm/impl", repo, state: "ready" }));
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cfgWith(root), results, ADD(repo));
    equal(wt.path, resolve(stale), "the record wins even when nothing is on disk yet — recomputing would strand the tree");
    ok(existsSync(join(wt.path, "a.txt")), "the tree is re-created where the record says");
  } finally {
    dropWorktree(repo, stale);
    cleanup(root, results, repo);
  }
});
