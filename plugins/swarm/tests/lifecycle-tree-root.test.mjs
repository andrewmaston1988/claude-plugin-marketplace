// Prune, nudge and dead-engine recovery must find resolver-created trees while
// the run keeps its own history, even if the scratch root is later deleted.
import "./helpers/isolate-home.mjs";
import { after, test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { plan, makeGit } from "../src/prune.mjs";
import { projectRunsHoldingWorktrees } from "../src/prune-nudge.mjs";
import { prepareIsolation, treeDirFor, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { swarmHome, runsKeyFor } from "../src/config.mjs";
import { listRuns, readRun } from "../src/runlog.mjs";
import { buildSnapshot } from "../src/serve/estate.mjs";
import { runCli } from "./helpers/cli.mjs";
import { gitOut } from "./helpers/cli-fixture.mjs";
import { initRepo, cleanup, commitAll, dropWorktree, CFG, ADD } from "./helpers/worktree-fixtures.mjs";

const SESSION = "sess-lifecycle";

// A run dir in the REAL shape — <swarmHome>/runs/<encoded>/<run> — because the
// resolver's inverse (runOfTree) is only exact against the runs root it was built
// from, and prune/nudge ownership is judged with it.
const runDir = (name, key = "C--code-lifecycle") => join(swarmHome(), "runs", runsKeyFor(key), name);
const scratchTree = (name, tree) => resolve(join(swarmHome(), "worktrees", runsKeyFor("C--code-lifecycle"), name, tree));

// A finished run: run.log then summary.json, in that order — runLiveness trusts the
// summary only while its mtime is the later of the two.
function finishRun(dir, { kept = [], summary = {} } = {}) {
  const t = Date.now() - 60_000;
  const line = (o) => JSON.stringify({ ts: new Date(t).toISOString(), ...o }) + "\n";
  writeFileSync(join(dir, "run.log"), line({ event: "run-start", launcher: SESSION, tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    started: new Date(t).toISOString(),
    finished: new Date(t + 1).toISOString(),
    tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001", state: "ok" }],
    blocked: [],
    worktreesKept: kept,
    totalTokens: null,
    ...summary,
  }));
}

// A tree the run created through the resolver, with its per-tree record dropped —
// the "killed add / lost record" case the scratch-dir scan exists for.
function treeWithoutRecord(repo, dir, name = "impl") {
  mkdirSync(dir, { recursive: true });
  const wt = prepareIsolation({ id: name, originalCwd: repo, cwd: repo }, CFG, dir, ADD(repo));
  rmSync(join(dir, "trees"), { recursive: true, force: true });
  return wt;
}

test("prune finds a tree in the run's scratch dir that neither a record nor summary.json names", () => {
  const repo = initRepo();
  const dir = runDir("prune-scratch-discovery");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    equal(wt.path, scratchTree("prune-scratch-discovery", "impl"), "the tree must be under treeRoot, not the run dir");
    finishRun(dir, { kept: [] });

    const { rows } = plan({ live: false, repos: [repo], resultsDir: dir, worktreesKept: [] }, makeGit(spawnSync), nodeFs);
    ok(rows.some((r) => r.path === wt.path),
      `prune must discover ${wt.path} — the run dir no longer contains its trees: ${JSON.stringify(rows)}`);
    equal(rows[0].repo, resolve(repo), "the repo comes from the tree itself when no record names one");
    equal(rows[0].branch, "swarm/impl");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

test("prune's refusal is unchanged: unlanded work in a scratch-dir tree still blocks the destroy", () => {
  const repo = initRepo();
  const dir = runDir("prune-scratch-unlanded");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    writeFileSync(join(wt.path, "a.txt"), "unlanded\n");
    commitAll(wt.path, "unlanded work");
    finishRun(dir, { kept: [] });

    const { rows } = plan({ live: false, repos: [repo], resultsDir: dir, worktreesKept: [] }, makeGit(spawnSync), nodeFs);
    equal(rows.length, 1, "the scratch-dir tree is a row");
    equal(rows[0].unlanded, 1, "the unlanded commit is measured against the tree's own repo");
    ok(rows[0].unlanded > 0, "a tree carrying work must be a blocker wherever it lives");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

test("prune still discovers and removes a legacy <run>/wt-* tree — the pre-upgrade layout is untouched", () => {
  const repo = initRepo();
  const dir = runDir("prune-legacy");
  const legacy = join(dir, "wt-impl");
  try {
    mkdirSync(dir, { recursive: true });
    const { status } = spawnSync("git", ["worktree", "add", "-b", "swarm/impl", legacy], { cwd: repo, windowsHide: true });
    equal(status, 0, "legacy tree registered");
    finishRun(dir, { kept: [] });

    const { rows } = plan({ live: false, repos: [repo], resultsDir: dir, worktreesKept: [] }, makeGit(spawnSync), nodeFs);
    ok(rows.some((r) => r.path === resolve(legacy)), `a legacy tree is still a row: ${JSON.stringify(rows)}`);
    equal(rows[0].branch, "swarm/impl");
  } finally {
    dropWorktree(repo, legacy);
    cleanup(dir, repo);
  }
});

test("the nudge counts a finished run's scratch-dir tree even when summary.json lists none", () => {
  const repo = initRepo();
  const dir = runDir("nudge-scratch");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    finishRun(dir, { kept: [] });

    const runs = projectRunsHoldingWorktrees({ home: swarmHome(), toplevel: "C--code-lifecycle", sessionId: SESSION });
    equal(runs.mine.length, 1, "the run holds a tree on disk, so this session must be nudged about it");
    equal(runs.mine[0].kept, 1);
    equal(runs.mine[0].dir, resolve(dir));
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

test("the nudge stays silent for a live run holding a scratch-dir tree", () => {
  const repo = initRepo();
  const dir = runDir("nudge-live");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    // A run with no summary at all: runLiveness reads it as live and prune would refuse it.
    writeFileSync(join(dir, "run.log"), JSON.stringify({ ts: Date.now(), event: "run-start", launcher: SESSION, tasks: [] }) + "\n");
    writeFileSync(join(dir, "heartbeat"), `${new Date().toISOString()} 1234\n`);

    const runs = projectRunsHoldingWorktrees({ home: swarmHome(), toplevel: "C--code-lifecycle", sessionId: SESSION });
    equal(runs.mine.length, 0, "a live run is never named — prune would refuse it");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

test("prune (CLI) removes an unrecorded new-layout run's tree and branch", () => {
  const repo = initRepo();
  const dir = runDir("cli-prune-scratch");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    finishRun(dir, { kept: [] , summary: {} });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ resultsDir: dir, cwd: repo, tasks: [] }));

    const r = runCli(["prune", dir], { cwd: repo });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), `prune must name the tree it removed: ${r.stdout}`);
    ok(existsSync(wt.path) === false, "the tree under treeRoot must be gone");
    equal(gitOut(["branch", "--list", "swarm/impl"], repo), "", "its branch must be gone too");
    ok(existsSync(join(dir, "run.log")), "the run's history survives the prune");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

test("prune (CLI) removes a recorded tree's record and empty treeRoot parents", () => {
  const repo = initRepo();
  const name = "cli-prune-recorded";
  // Its own project key: the shipped default root is shared with the rows above,
  // whose empty parent dirs would otherwise keep the project directory non-empty.
  const dir = runDir(name, "C--code-lifecycle-recorded");
  const projectDir = join(swarmHome(), "worktrees", runsKeyFor("C--code-lifecycle-recorded"));
  const runTreeDir = join(projectDir, name);
  const outsideCanary = join(swarmHome(), "tree-root-prune-outside-canary");
  let wt;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(outsideCanary, "keep");
    wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, CFG, dir, ADD(repo));
    equal(resolve(wt.path), resolve(join(runTreeDir, "impl")), "the tree must sit under the default treeRoot");
    finishRun(dir, { kept: [] });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ resultsDir: dir, cwd: repo, tasks: [] }));

    const record = join(dir, "trees", "impl.json");
    ok(existsSync(record), "prepareIsolation wrote the tree record");
    const r = runCli(["prune", dir], { cwd: repo, env: { SWARM_HOME: swarmHome() } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), `prune must name the tree it removed: ${r.stdout}`);
    deepEqual([
      existsSync(record) ? "tree record" : null,
      existsSync(runTreeDir) ? "per-run treeRoot directory" : null,
      existsSync(projectDir) ? "empty project directory" : null,
      existsSync(outsideCanary) ? null : "outside treeRoot canary",
    ].filter(Boolean), [], "prune must remove the record and empty treeRoot parents");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    rmSync(outsideCanary, { force: true });
    cleanup(dir, repo);
  }
});

test("swarm stop on a dead engine records the scratch-dir tree and prints its prune hint", () => {
  const repo = initRepo();
  const dir = runDir("cli-stop-scratch");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ resultsDir: dir, cwd: repo, tasks: [] }));
    const line = (o) => JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n";
    const runLog = join(dir, "run.log");
    const heartbeat = join(dir, "heartbeat");
    const stale = new Date(Date.now() - 120_000);
    writeFileSync(runLog,
      line({ event: "run-start", launcher: SESSION, tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001" }] }) +
      line({ id: "impl", state: "running" }));
    writeFileSync(heartbeat, `${stale.toISOString()} 1234\n`);
    // The shipped heartbeat is 15 s and a run quiet for 45 s reads as dead; backdate
    // the fixture rather than shrink the beat, so the row runs on the defaults.
    utimesSync(runLog, stale, stale);
    utimesSync(heartbeat, stale, stale);

    const r = runCli(["stop", dir], { cwd: repo });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), `the dead-engine record must name the tree: ${r.stdout}`);
    ok(r.stdout.includes("prune when done"), r.stdout);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    equal(summary.worktreesKept.length, 1);
    equal(summary.worktreesKept[0].path, wt.path);
    equal(summary.worktreesKept[0].branch, "swarm/impl");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

// History lives in the run dir, so a kept tree's root going missing can never cost
// the run its record. The root is never created at all — nothing is deleted.
test("a kept tree whose root is gone leaves the run's results, summary and dashboard row readable", () => {
  const dir = runDir("guard-gone-root");
  const goneTree = join(swarmHome(), "tree-root-never-created", runsKeyFor("C--code-lifecycle"), "guard-gone-root", "impl");
  try {
    mkdirSync(dir, { recursive: true });
    finishRun(dir, { kept: [{ name: "impl", branch: "swarm/impl", path: goneTree }] });
    ok(!existsSync(goneTree), "the recorded tree's root must never be created — history cannot depend on it");

    const listed = listRuns(swarmHome()).map((r) => r.dir);
    ok(listed.includes(resolve(dir)), `the run must still be listed: ${JSON.stringify(listed)}`);
    equal(readRun(dir).tasks.length, 1, "the run's leaves still read");
    equal(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).finished.length > 0, true, "the summary still reads");
    const snapshot = buildSnapshot(swarmHome(), new Map());
    ok(snapshot.rows.some((row) => row.name === "guard-gone-root"), "the dashboard still has the run");
  } finally {
    cleanup(dir);
  }
});

test("treeDirFor and prune agree on where a recorded tree lives", () => {
  const repo = initRepo();
  const dir = runDir("agree-on-path");
  let wt;
  try {
    wt = treeWithoutRecord(repo, dir);
    finishRun(dir, { kept: [] });
    deepEqual(resolve(treeDirFor(dir, "impl", CFG)), resolve(wt.path),
      "prune's discovery and the resolver must name the same path, or one of them is looking in the old place");
  } finally {
    if (wt) dropWorktree(repo, wt.path);
    cleanup(dir, repo);
  }
});

// Every row above runs on the shipped defaults. A user config materialised in the
// test home would mean one has started shaping its fixture through the home.
after(() => {
  ok(!existsSync(join(process.env.SWARM_HOME, "config.json")), "no row may create the home's config");
});
