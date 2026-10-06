// The `swarm prune` subcommand's CLI tests, split out of cli.test.mjs. Fixtures
// shared with the sweeps still in cli.test.mjs live in helpers/prune-fixture.mjs.
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { commitAll, gitOut, tmp } from "./helpers/cli-fixture.mjs";
import { prepareIsolation, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { initPruneRepo, writeFinishedRun, pruneFixture, addDetachedTree, writeKilledRun, dropSnapPrune } from "./helpers/prune-fixture.mjs";

test("prune --dry-run: a finished run with a kept worktree prints the table and removes nothing", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);

    const r = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("swarm/impl"), r.stdout);
    ok(/would free/.test(r.stdout), r.stdout);

    ok(existsSync(wt.path), "dry-run must not remove the worktree");
    ok(gitOut(["branch", "--list", "swarm/impl"], repo), "dry-run must not remove the branch");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: removes the worktree and branch, prints freed, leaves the run record untouched", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);
    const runLog = readFileSync(join(resultsDir, "run.log"), "utf8");
    const summary = readFileSync(join(resultsDir, "summary.json"), "utf8");

    const r = runCli(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
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

test("prune --dry-run: a kept worktree whose path is already gone from disk is not a prune row — nothing to prune", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: join(resultsDir, "wt-gone") }]);

    const r = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/has no kept worktrees — nothing to prune/.test(r.stdout), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: a real prune rewrites worktreesKept to drop the pruned entry; a second prune finds nothing", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);

    const r = runCli(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);

    const summary = JSON.parse(readFileSync(join(resultsDir, "summary.json"), "utf8"));
    deepEqual(summary.worktreesKept, []);

    const r2 = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r2.status, 0, r2.stdout + r2.stderr);
    ok(/has no kept worktrees — nothing to prune/.test(r2.stdout), r2.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune --dry-run: summary.json is left byte-identical", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, [{ name: "impl", branch: "swarm/impl", path: wt.path }]);
    const before = readFileSync(join(resultsDir, "summary.json"), "utf8");

    const r = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    equal(readFileSync(join(resultsDir, "summary.json"), "utf8"), before, "dry-run must never write summary.json");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune: the flag may come first, and a dir with no run.log is an error, not a live run", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-prune-args-"));
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    const missing = join(dir, "home", "runs", "C--proj", "does-not-exist");
    const r = runCli(["prune", "--dry-run", missing], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/no run at/.test(r.stderr), r.stderr);
    ok(!/live/.test(r.stderr), r.stderr);
    // the flag itself must never be taken as the dir
    ok(!/--dry-run/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune: refuses a live run (fresh heartbeat, no summary) — exit 1, nothing removed", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(resultsDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [{ id: "impl", provider: "claude", model: "claude-haiku-4-5-20251001" }] }) + "\n");
    writeFileSync(join(resultsDir, "heartbeat"), `${new Date().toISOString()} 1234\n`);

    const r = runCli(["prune", resultsDir], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("live — swarm stop it first"), r.stderr);

    ok(existsSync(wt.path), "a live run's worktree must not be touched");
    ok(gitOut(["branch", "--list", "swarm/impl"], repo), "a live run's branch must not be touched");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prune --dry-run: a dead-engine-stopped run with no kept worktree still finds an orphan via manifest.json's cwd", () => {
  const repo = initPruneRepo();
  const dir = tmp();
  try {
    const resultsDir = join(dir, "out");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify({ resultsDir, cwd: repo, tasks: [] }));
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, { worktreeBranchPrefix: "swarm/" }, resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    spawnSync("git", ["merge", "-q", "swarm/impl"], { cwd: repo, windowsHide: true });

    writeFinishedRun(resultsDir, false);

    const r = runCli(["prune", resultsDir, "--dry-run"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(wt.path), r.stdout);
    ok(r.stdout.includes("swarm/impl"), r.stdout);
    ok(existsSync(wt.path), "dry-run must not remove the worktree");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "out", "wt-impl")], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- prune over a run's leftover worktrees ---

test("prune: a run that ended normally still has its leftover tree removed — the sweep goes before the nothing-to-prune exit", () => {
  const f = pruneFixture();
  try {
    // A run that finished with nothing kept, yet left a tree registered under its
    // resultsDir: row discovery is the repo registry, not summary.worktreesKept, so
    // the empty record must not short-circuit the sweep.
    writeFinishedRun(f.resultsDir, []);
    addDetachedTree(f);
    ok(existsSync(f.tree));
    const env = { SWARM_HOME: join(f.dir, "home") };
    const dry = runCli(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    ok(dry.stdout.includes(f.tree), dry.stdout);
    ok(existsSync(f.tree), "dry-run keeps the tree");
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(f.tree), "tree removed");
    ok(!gitOut(["worktree", "list", "--porcelain"], f.repo).includes("wt-impl"), "tree deregistered");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: unlanded commit and dirty tree are preserved until explicit discard", () => {
  const f = pruneFixture();
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, { worktreeBranchPrefix: "swarm/" }, f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "a.txt"), "unlanded\n");
    commitAll(wt.path, "unlanded work");
    writeFileSync(join(wt.path, "new.txt"), "dirty\n");
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const env = { SWARM_HOME: join(f.dir, "home") };
    const refused = runCli(["prune", f.resultsDir], { cwd: f.dir, env });
    ok(existsSync(wt.path), "blocked worktree must survive refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "blocked branch must survive refusal");
    equal(refused.status, 1, refused.stdout + refused.stderr);
    ok(refused.stderr.includes(wt.path) && refused.stderr.includes("--discard-unlanded"), refused.stderr);
    const discarded = runCli(["prune", f.resultsDir, "--discard-unlanded"], { cwd: f.dir, env });
    equal(discarded.status, 0, discarded.stdout + discarded.stderr);
    ok(!existsSync(wt.path), "explicit discard removes the worktree");
    ok(!gitOut(["branch", "--list", wt.branch], f.repo), "explicit discard removes the branch");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a squash-landed branch measures landed and is pruned", () => {
  const f = pruneFixture();
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, { worktreeBranchPrefix: "swarm/" }, f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "a.txt"), "landed\n");
    commitAll(wt.path, "landed work");
    // Squash-land: the branch's patch is on master but its commit sha is not, so a
    // sha-range count would call it unlanded. `git cherry` is patch-based, and the
    // squash-merge path is the documented landing route — it must read as landed.
    spawnSync("git", ["merge", "--squash", "-q", wt.branch], { cwd: f.repo, windowsHide: true });
    commitAll(f.repo, "squash-land");
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(wt.path), "a squash-landed worktree is pruned");
    ok(!gitOut(["branch", "--list", wt.branch], f.repo), "a squash-landed branch is deleted");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: an unlanded-only row on a clean tree is refused, and the worktree and branch both survive", () => {
  const f = pruneFixture();
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, { worktreeBranchPrefix: "swarm/" }, f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "a.txt"), "unlanded\n");
    commitAll(wt.path, "unlanded work"); // committed — the tree itself is clean
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const env = { SWARM_HOME: join(f.dir, "home") };
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env });
    ok(existsSync(wt.path), "unlanded-only worktree must survive refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "unlanded-only branch must survive refusal");
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(wt.path) && r.stderr.includes("--discard-unlanded"), r.stderr);
    const dry = runCli(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    ok(dry.stdout.includes("1 unlanded"), dry.stdout);
    ok(!/uncommitted/.test(dry.stdout), `a clean tree must show no uncommitted count: ${dry.stdout}`);
    ok(existsSync(wt.path), "dry-run keeps the worktree");
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a dirty-only row on a landed branch is refused, and the uncommitted file survives", () => {
  const f = pruneFixture();
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, { worktreeBranchPrefix: "swarm/" }, f.resultsDir, { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    writeFileSync(join(wt.path, "a.txt"), "landed\n");
    commitAll(wt.path, "landed work");
    spawnSync("git", ["merge", "-q", wt.branch], { cwd: f.repo, windowsHide: true });
    writeFileSync(join(wt.path, "scratch.txt"), "uncommitted\n"); // untracked
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    ok(existsSync(join(wt.path, "scratch.txt")), "the uncommitted file must survive refusal");
    ok(gitOut(["branch", "--list", wt.branch], f.repo), "landed branch must survive a dirty-tree refusal");
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(wt.path) && r.stderr.includes("--discard-unlanded"), r.stderr);
  } finally {
    dropSnapPrune(f);
  }
});

test("prune: a killed run's leftover tree (no summary.json) is removed without a branch delete, and no summary is invented", () => {
  const f = pruneFixture();
  try {
    addDetachedTree(f);
    ok(existsSync(f.tree));
    writeKilledRun(f);
    const branchesBefore = gitOut(["branch", "--list"], f.repo);
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("(detached)") && !/snapshot/.test(r.stdout), r.stdout);
    ok(!existsSync(f.tree), "tree removed");
    equal(gitOut(["branch", "--list"], f.repo), branchesBefore, "no branch touched");
    ok(!existsSync(join(f.resultsDir, "summary.json")), "prune must not write a summary.json the run never had");
  } finally {
    dropSnapPrune(f);
  }
});

// RED as written, and it is a src defect rather than a stale fixture — see the note on
// the sibling row below.
test("prune: a second repo's leftover tree is removed too, not just the first repo's", () => {
  const f = pruneFixture();
  const repo2 = initPruneRepo();
  try {
    const sha2 = gitOut(["rev-parse", "HEAD"], repo2);
    const tree2 = join(f.resultsDir, "wt-two");
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
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(f.tree), "first tree removed");
    ok(!existsSync(tree2), "second repo's tree removed");
    ok(!gitOut(["worktree", "list", "--porcelain"], repo2).includes("wt-two"), "second repo deregistered");
  } finally {
    dropSnapPrune(f);
    rmSync(repo2, { recursive: true, force: true });
  }
});

// RED as written: `execute()` (src/prune.mjs:80) runs `git worktree remove` with
// cwd = row.repo, and every row's repo is the single one cmdPrune resolved
// (scripts/swarm.mjs:616-621 resolved a repo per snapshot event until 46003f5).
// A tree registered in a second repo therefore survives, silently — prune still
// prints "freed … across 2 worktrees". Not a fixture problem; left red on purpose.
test("prune: a killed run with leftover trees in two repos removes both, and invents no summary", () => {
  const f = pruneFixture();
  const repo2 = initPruneRepo();
  try {
    const sha2 = gitOut(["rev-parse", "HEAD"], repo2);
    const tree2 = join(f.resultsDir, "wt-two");
    addDetachedTree(f);
    addDetachedTree(f, repo2, tree2, sha2);
    // A killed run wrote no summary, so the manifest task cwds are the only record
    // that this run reached a second repo — a real two-repo manifest carries them.
    writeFileSync(join(f.resultsDir, "manifest.json"),
      JSON.stringify({ resultsDir: f.resultsDir, cwd: f.repo, tasks: [{ id: "two", cwd: repo2 }] }));
    writeKilledRun(f);
    ok(existsSync(f.tree) && existsSync(tree2));
    const r = runCli(["prune", f.resultsDir], { cwd: f.dir, env: { SWARM_HOME: join(f.dir, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(f.tree), "first tree removed");
    ok(!existsSync(tree2), "second tree removed");
    for (const [repo, name] of [[f.repo, "wt-impl"], [repo2, "wt-two"]]) {
      ok(!gitOut(["worktree", "list", "--porcelain"], repo).includes(name), `${name} still registered`);
    }
    ok(!existsSync(join(f.resultsDir, "summary.json")), "prune must not write a summary.json the run never had");
  } finally {
    dropSnapPrune(f);
    rmSync(repo2, { recursive: true, force: true });
  }
});
