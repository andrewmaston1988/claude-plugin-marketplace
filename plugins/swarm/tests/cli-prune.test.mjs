// The `swarm prune` subcommand's CLI tests, split out of cli.test.mjs. Fixtures
// shared with the sweeps still in cli.test.mjs live in helpers/prune-fixture.mjs.
import "./helpers/isolate-home.mjs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliInProcess } from "./helpers/cli.mjs";
import { commitAll, gitOut, tmp } from "./helpers/cli-fixture.mjs";
import { prepareIsolation, treeDirFor, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { initPruneRepo, writeFinishedRun, pruneFixture, addDetachedTree, writeKilledRun, dropSnapPrune } from "./helpers/prune-fixture.mjs";

const cliCfg = (dir) => ({ worktreeBranchPrefix: "swarm/", treeRoot: join(dir, "home", "worktrees") });
const cliTree = (dir, resultsDir, name) => treeDirFor(resultsDir, name, cliCfg(dir));

test("prune --dry-run: a finished run with a kept worktree prints the table and removes nothing", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = await prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cliCfg(dir), resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], repo) });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);

    const r = await runCliInProcess(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("swarm/impl"), r.stdout);
    ok(/would free/.test(r.stdout), r.stdout);

    ok(existsSync(wt.path), "dry-run must not remove the worktree");
    ok(gitOut(["branch", "--list", "swarm/impl"], repo), "dry-run must not remove the branch");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", cliTree(dir, join(dir, "out"), "impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: removes the worktree and branch, prints freed, leaves the run record untouched", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = await prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cliCfg(dir), resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], repo) });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);
    const runLog = readFileSync(join(resultsDir, "run.log"), "utf8");
    const summary = readFileSync(join(resultsDir, "summary.json"), "utf8");

    const r = await runCliInProcess(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/freed [\d.]+ GB across 1 worktree/.test(r.stdout), r.stdout);

    ok(!existsSync(wt.path), "the worktree directory must be gone");
    equal(gitOut(["branch", "--list", "swarm/impl"], repo), "", "the branch must be gone");
    equal(readFileSync(join(resultsDir, "run.log"), "utf8"), runLog, "run.log must survive prune");
    const newSummary = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    deepEqual(newSummary.worktreesKept, [], "the pruned entry must be dropped from the record");
    ok(readFileSync(join(resultsDir, "summary.json"), "utf8") !== summary, "summary.json must be rewritten, not left claiming a dead worktree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune --dry-run: a kept worktree whose path is already gone from disk is not a prune row — nothing to prune", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: cliTree(dir, resultsDir, "gone") }]);

    const r = await runCliInProcess(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/has no kept worktrees or branches — nothing to prune/.test(r.stdout), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: a real prune rewrites worktreesKept to drop the pruned entry; a second prune finds nothing", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    const wt = await prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cliCfg(dir), resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], repo) });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);

    const r = await runCliInProcess(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);

    const summary = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    deepEqual(summary.worktreesKept, []);

    const r2 = await runCliInProcess(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r2.status, 0, r2.stdout + r2.stderr);
    ok(/has no kept worktrees or branches — nothing to prune/.test(r2.stdout), r2.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune --dry-run: summary.json is left byte-identical", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = await prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cliCfg(dir), resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], repo) });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);
    const before = readFileSync(join(resultsDir, "summary.json"), "utf8");

    const r = await runCliInProcess(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    equal(readFileSync(join(resultsDir, "summary.json"), "utf8"), before, "dry-run must never write summary.json");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", cliTree(dir, join(dir, "out"), "impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: the flag may come first, and a dir with no run.log is an error, not a live run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-prune-args-"));
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    const missing = join(dir, "home", "runs", "C--proj", "does-not-exist");
    const r = await runCliInProcess(["prune", "--dry-run", missing], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/no run at/.test(r.stderr), r.stderr);
    ok(!/live/.test(r.stderr), r.stderr);
    // the flag itself must never be taken as the dir
    ok(!/--dry-run/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune: refuses a live run (fresh heartbeat, no summary) — exit 1, nothing removed", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = await prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cliCfg(dir), resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], repo) });
    writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001" }] }) + "\n");
    writeFileSync(join(resultsDir, "heartbeat"), `${new Date().toISOString()} 1234\n`);

    const r = await runCliInProcess(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("live — swarm stop it first"), r.stderr);

    ok(existsSync(wt.path), "a live run's worktree must not be touched");
    ok(gitOut(["branch", "--list", "swarm/impl"], repo), "a live run's branch must not be touched");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", cliTree(dir, join(dir, "out"), "impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune --dry-run: a dead-engine-stopped run with no kept worktree still finds an orphan via manifest.json's cwd", async () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    const wt = await prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, cliCfg(dir), resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], repo) });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, false);

    const r = await runCliInProcess(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("swarm/impl"), r.stdout);
    ok(existsSync(wt.path), "dry-run must not remove the worktree");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", cliTree(dir, join(dir, "out"), "impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- prune over a run's leftover worktrees ---

test("prune: a run that ended normally still has its leftover tree removed — the sweep goes before the nothing-to-prune exit", async () => {
  const f = pruneFixture();
  try {
    // A run that finished with nothing kept, yet left a tree registered under its
    // resultsDir: row discovery is the repo registry, not summary.worktreesKept, so
    // the empty record must not short-circuit the sweep.
    writeFinishedRun(f.resultsDir, []);
    addDetachedTree(f);
    ok(existsSync(f.tree));
    const env = { SWARM_HOME: join(f.dir, "home") };
    const dry = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    ok(dry.stdout.includes(f.tree), dry.stdout);
    ok(existsSync(f.tree), "dry-run keeps the tree");
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(f.tree), "tree removed");
    ok(!gitOut(["worktree", "list", "--porcelain"], f.repo).includes("impl"), "tree deregistered");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: unlanded commit and dirty tree are preserved until explicit discard", async () => {
  const f = pruneFixture();
  try {
    const wt = await prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "a.txt"), "unlanded\n");
    commitAll(wt.path, "unlanded work");
    writeFileSync(join(wt.path, "new.txt"), "dirty\n");
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const env = { SWARM_HOME: join(f.dir, "home") };
    const refused = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env });
    ok(existsSync(wt.path), "blocked worktree must survive refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "blocked branch must survive refusal");
    equal(refused.status, 1, refused.stdout + refused.stderr);
    ok(refused.stderr.includes(wt.path) && refused.stderr.includes("--discard-unlanded"), refused.stderr);
    ok(!/freed/.test(refused.stdout), `a refused prune must not report freed space: ${refused.stdout}`);
    const discarded = await runCliInProcess(["prune", f.resultsDir, "--discard-unlanded"], { cwd: f.dir, env });
    equal(discarded.status, 0, discarded.stdout + discarded.stderr);
    ok(!existsSync(wt.path), "explicit discard removes the worktree");
    ok(!gitOut(["branch", "--list", wt.branch], f.repo), "explicit discard removes the branch");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a squash-landed branch measures landed and is pruned", async () => {
  const f = pruneFixture();
  try {
    const wt = await prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "a.txt"), "landed\n");
    commitAll(wt.path, "landed work");
    // Squash-land: the branch's patch is on master but its commit sha is not, so a
    // sha-range count would call it unlanded. `git cherry` is patch-based, and the
    // squash-merge path is the documented landing route — it must read as landed.
    spawnSync("git", ["merge", "--squash", "-q", wt.branch], { cwd: f.repo, windowsHide: true });
    commitAll(f.repo, "squash-land");
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(wt.path), "a squash-landed worktree is pruned");
    ok(!gitOut(["branch", "--list", wt.branch], f.repo), "a squash-landed branch is deleted");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: an unlanded-only row on a clean tree is refused, and the worktree and branch both survive", async () => {
  const f = pruneFixture();
  try {
    const wt = await prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "a.txt"), "unlanded\n");
    commitAll(wt.path, "unlanded work"); // committed — the tree itself is clean
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const env = { SWARM_HOME: join(f.dir, "home") };
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env });
    ok(existsSync(wt.path), "unlanded-only worktree must survive refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "unlanded-only branch must survive refusal");
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(wt.path) && r.stderr.includes("--discard-unlanded"), r.stderr);
    const dry = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    ok(dry.stdout.includes("1 unlanded"), dry.stdout);
    ok(!/uncommitted/.test(dry.stdout), `a clean tree must show no uncommitted count: ${dry.stdout}`);
    ok(existsSync(wt.path), "dry-run keeps the worktree");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a dirty-only row on a landed branch is refused, and the uncommitted file survives", async () => {
  const f = pruneFixture();
  try {
    const wt = await prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "a.txt"), "landed\n");
    commitAll(wt.path, "landed work");
    spawnSync("git", ["merge", "-q", wt.branch], { cwd: f.repo, windowsHide: true });
    writeFileSync(join(wt.path, "scratch.txt"), "uncommitted\n"); // untracked
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    ok(existsSync(join(wt.path, "scratch.txt")), "the uncommitted file must survive refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "landed branch must survive a dirty-tree refusal");
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(wt.path) && r.stderr.includes("--discard-unlanded"), r.stderr);
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a killed run's leftover tree (no summary.json) is removed without a branch delete, and no summary is invented", async () => {
  const f = pruneFixture();
  try {
    addDetachedTree(f);
    ok(existsSync(f.tree));
    writeKilledRun(f);
    const branchesBefore = gitOut(["branch", "--list"], f.repo);
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("(detached)") && !/snapshot/.test(r.stdout), r.stdout);
    ok(!existsSync(f.tree), "tree removed");
    equal(gitOut(["branch", "--list"], f.repo), branchesBefore, "no branch touched");
    ok(!existsSync(join(f.resultsDir, "summary.json")), "prune must not write a summary.json the run never had");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a detached tree holding its own commit is refused, and the commit survives", async () => {
  const f = pruneFixture();
  try {
    // A branchless tree is not automatically empty: an agent that kept working in a
    // tree left detached by a killed `worktree add` commits there, and those commits
    // are reachable from HEAD only — `worktree remove` would unreference them.
    addDetachedTree(f);
    writeFileSync(join(f.tree, "own.txt"), "orphan work\n");
    commitAll(f.tree, "commit in the detached tree");
    const head = gitOut(["rev-parse", "HEAD"], f.tree);
    writeKilledRun(f);

    const env = { SWARM_HOME: join(f.dir, "home") };
    const refused = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env });
    equal(refused.status, 1, refused.stdout + refused.stderr);
    ok(refused.stderr.includes(f.tree) && refused.stderr.includes("--discard-unlanded"), refused.stderr);
    ok(!/freed/.test(refused.stdout), `a refused prune must not report freed space: ${refused.stdout}`);
    ok(existsSync(f.tree), "the detached tree must survive the refusal");
    equal(gitOut(["rev-parse", "HEAD"], f.tree), head, "the detached tree's own commit must survive");

    const discarded = await runCliInProcess(["prune", f.resultsDir, "--discard-unlanded"], { cwd: f.dir, env });
    equal(discarded.status, 0, discarded.stdout + discarded.stderr);
    ok(!existsSync(f.tree), "an explicit discard still destroys the detached tree");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a second repo's leftover tree is removed too, not just the first repo's", async () => {
  const f = pruneFixture();
  const repo2 = initPruneRepo();
  try {
    const sha2 = gitOut(["rev-parse", "HEAD"], repo2);
    const tree2 = cliTree(f.dir, f.resultsDir, "two");
    addDetachedTree(f);
    addDetachedTree(f, repo2, tree2, sha2);
    writeKilledRun(f);
    // A second repo now has no signal at all: manifest.json names one cwd and the
    // run.log `snapshot` events that used to name the other are gone.
    writeFileSync(join(f.resultsDir, "summary.json"), JSON.stringify({
      started: new Date().toISOString(), finished: new Date().toISOString(), tasks: [], blocked: [],
      worktreesKept: [
        { name: "impl", branch: null, path: f.tree },
        { name: "two", branch: null, path: tree2 },
      ], totalTokens: null,
    }));
    ok(existsSync(f.tree) && existsSync(tree2));
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(f.tree), "first tree removed");
    ok(!existsSync(tree2), "second repo's tree removed");
    ok(!gitOut(["worktree", "list", "--porcelain"], repo2).includes("two"), "second repo deregistered");
  } finally {
    dropSnapPrune(f);
    rmSync(repo2, { recursive: true, force: true });
  }
});

test("row 10: prune from the porting worktree frees a cherry-picked run; from the main checkout it refuses", async () => {
  const f = pruneFixture();
  const portTree = join(f.dir, "porting");
  try {
    const wt = await prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "a.txt"), "ported\n");
    commitAll(wt.path, "leaf work");
    // A feature branch in its own worktree receives the leaf's patch as a new SHA:
    // nothing git can see from the main checkout holds the leaf's tip.
    spawnSync("git", ["worktree", "add", "-q", "-b", "feat", portTree, "master"], { cwd: f.repo, windowsHide: true });
    // Diverge first: a pick onto the leaf's own parent replays the identical commit
    // and lands the leaf's own SHA, proving nothing about the porting tree's base.
    writeFileSync(join(portTree, "port-base.txt"), "port base\n");
    commitAll(portTree, "port base");
    const leafTip = gitOut(["rev-parse", "HEAD"], wt.path);
    const picked = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
      "cherry-pick", leafTip], { cwd: portTree, windowsHide: true });
    equal(picked.status, 0, String(picked.stderr));
    ok(gitOut(["rev-parse", "HEAD"], portTree) !== leafTip,
      "precondition: the cherry-pick is a new commit, not the leaf's own SHA");
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const env = { SWARM_HOME: join(f.dir, "home") };

    const refused = await runCliInProcess(["prune", f.resultsDir], { cwd: f.repo, env });
    equal(refused.status, 1, refused.stdout + refused.stderr);
    ok(refused.stderr.includes("1 unlanded"), `the main checkout's HEAD does not hold the cherry-pick: ${refused.stderr}`);
    ok(existsSync(wt.path), "the refusal keeps the tree");

    const freed = await runCliInProcess(["prune", f.resultsDir], { cwd: portTree, env });
    equal(freed.status, 0, freed.stdout + freed.stderr);
    ok(!existsSync(wt.path), "the ported run's tree is pruned");
    ok(!gitOut(["branch", "--list", wt.branch], f.repo), "the ported run's branch is deleted");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", portTree], { cwd: f.repo, windowsHide: true });
    dropSnapPrune(f);
  }
});

test("row 17: prune from inside a leaf worktree still refuses the leaf's unlanded branch", async () => {
  const f = pruneFixture();
  try {
    const wt = await prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cliCfg(f.dir), f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "a.txt"), "unlanded\n");
    commitAll(wt.path, "leaf work");
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);

    // The leaf's own HEAD must never be a base: it would absorb the very branch
    // the prune is about to destroy.
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: wt.path, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("1 unlanded"), r.stderr);
    ok(existsSync(wt.path), "the leaf tree survives the refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "the leaf branch survives the refusal");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a killed run with leftover trees in two repos removes both, and invents no summary", async () => {
  const f = pruneFixture();
  const repo2 = initPruneRepo();
  try {
    const sha2 = gitOut(["rev-parse", "HEAD"], repo2);
    const tree2 = cliTree(f.dir, f.resultsDir, "two");
    addDetachedTree(f);
    addDetachedTree(f, repo2, tree2, sha2);
    // A killed run wrote no summary, so the manifest task cwds are the only record
    // that this run reached a second repo — a real two-repo manifest carries them.
    writeFileSync(join(f.resultsDir, "manifest.json"),
      JSON.stringify({ resultsDir: f.resultsDir, cwd: f.repo, tasks: [{ id: "two", cwd: repo2 }] }));
    writeKilledRun(f);
    ok(existsSync(f.tree) && existsSync(tree2));
    const r = await runCliInProcess(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(f.tree), "first tree removed");
    ok(!existsSync(tree2), "second tree removed");
    for (const [repo, name] of [[f.repo, "impl"], [repo2, "two"]]) {
      ok(!gitOut(["worktree", "list", "--porcelain"], repo).includes(name), `${name} still registered`);
    }
    ok(!existsSync(join(f.resultsDir, "summary.json")), "prune must not write a summary.json the run never had");
  } finally {
    dropSnapPrune(f);
    rmSync(repo2, { recursive: true, force: true });
  }
});
