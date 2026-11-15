// Real git: the rows `swarm prune` used to miss — a registered tree whose directory is
// gone, and the run's own branches that no tree holds.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./helpers/cli.mjs";
import { commitAll, gitOut } from "./helpers/cli-fixture.mjs";
import { writeFinishedRun, pruneFixture, dropSnapPrune } from "./helpers/prune-fixture.mjs";
import { runScopeKey, treeDirFor } from "../src/worktree.mjs";
import { runPlan } from "../src/scheduler.mjs";
import {
  CFG, tmp as schedTmp, fakeSpawnFactory, makeIo, integrateLeaf, fixCloneTasks, initGitRepo, commitAllInRepo,
} from "./helpers/scheduler-fixtures.mjs";

const cliCfg = (dir) => ({ worktreeBranchPrefix: "swarm/", treeRoot: join(dir, "home", "worktrees") });

function gitIn(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// A branch with a tree, so git registers it; the caller then deletes the directory,
// which is what a killed `worktree add` or a hand-cleaned tree leaves behind.
function addBranchTree(repo, branch, path, { lock = false } = {}) {
  const added = gitIn(repo, ["worktree", "add", "-q", "-b", branch, path, "master"]);
  equal(added.status, 0, added.stderr);
  if (lock) equal(gitIn(repo, ["worktree", "lock", "--reason", "initializing", path]).status, 0);
}

for (const lock of [false, true]) {
  test(`row 1: a registered tree whose directory is gone is pruned${lock ? ", even locked" : ""}`, () => {
    const f = pruneFixture();
    const branch = `swarm/${runScopeKey(f.resultsDir)}/impl`;
    try {
      addBranchTree(f.repo, branch, f.tree, { lock });
      rmSync(f.tree, { recursive: true, force: true });
      writeFinishedRun(f.resultsDir, []);
      const env = { SWARM_HOME: join(f.dir, "home") };
      const config = cliCfg(f.dir);

      const dry = runCli(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env, config });
      equal(dry.status, 0, dry.stdout + dry.stderr);
      ok(dry.stdout.includes(f.tree), `a missing registered tree is still a row: ${dry.stdout}`);
      ok(!/uncommitted/.test(dry.stdout), `a directory that is gone holds no uncommitted work: ${dry.stdout}`);

      const pruned = runCli(["prune", f.resultsDir], { cwd: f.dir, env, config });
      equal(pruned.status, 0, pruned.stdout + pruned.stderr);
      ok(!gitOut(["worktree", "list", "--porcelain"], f.repo).includes("impl"), "the registration is gone");
      equal(gitOut(["branch", "--list", branch], f.repo), "", "the branch is gone");
    } finally {
      gitIn(f.repo, ["worktree", "prune"]);
      dropSnapPrune(f);
    }
  });
}

test("row 3: the run's own branches are rows with no tree — landed ones go, unlanded ones refuse", () => {
  const f = pruneFixture();
  const scope = runScopeKey(f.resultsDir);
  const landed = `swarm/${scope}/swept`;
  const open = `swarm/${scope}/open`;
  try {
    writeFinishedRun(f.resultsDir, []);
    equal(gitIn(f.repo, ["branch", landed, "master"]).status, 0);
    // A commit whose tree is then swept leaves the ref as the only thing holding it.
    const scratch = join(f.dir, "scratch-tree");
    equal(gitIn(f.repo, ["worktree", "add", "-q", "-b", open, scratch, "master"]).status, 0);
    writeFileSync(join(scratch, "open.txt"), "x\n");
    commitAll(scratch, "open work");
    equal(gitIn(f.repo, ["worktree", "remove", "--force", scratch]).status, 0);

    const env = { SWARM_HOME: join(f.dir, "home") };
    const config = cliCfg(f.dir);
    const dry = runCli(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env, config });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    ok(dry.stdout.includes("(no tree)"), dry.stdout);
    ok(dry.stdout.includes(landed) && dry.stdout.includes(open), dry.stdout);
    ok(dry.stdout.includes("1 unlanded"), dry.stdout);

    const partial = runCli(["prune", f.resultsDir], { cwd: f.dir, env, config });
    equal(partial.status, 1, partial.stdout + partial.stderr);
    ok(partial.stderr.includes("(no tree)") && partial.stderr.includes(open), partial.stderr);
    ok(/freed .* across 0 worktrees and 1 branch/.test(partial.stdout), partial.stdout);
    equal(gitOut(["branch", "--list", landed], f.repo), "", "the landed branch-only row goes");
    ok(gitOut(["branch", "--list", open], f.repo), "the unlanded branch-only row is kept");

    const discarded = runCli(["prune", f.resultsDir, "--discard-unlanded"], { cwd: f.dir, env, config });
    equal(discarded.status, 0, discarded.stdout + discarded.stderr);
    equal(gitOut(["branch", "--list", landed], f.repo), "", "the landed branch is deleted");
    equal(gitOut(["branch", "--list", open], f.repo), "", "--discard-unlanded is the operator's word");
  } finally {
    dropSnapPrune(f);
  }
});

test("row 4: another run's key, outside the prefix, an unscoped name and a held branch are never rows", () => {
  const f = pruneFixture();
  const scope = runScopeKey(f.resultsDir);
  const other = `swarm/${runScopeKey(join(f.dir, "other-run"))}/leaf`;
  const outsidePrefix = "agents/plain";
  const unscoped = "swarm/unscoped-name";
  const held = `swarm/${scope}/held`;
  try {
    writeFinishedRun(f.resultsDir, []);
    for (const name of [other, outsidePrefix, unscoped]) equal(gitIn(f.repo, ["branch", name, "master"]).status, 0);
    // Checked out in the main checkout: a branch a tree holds is never a branch-only row.
    equal(gitIn(f.repo, ["checkout", "-q", "-b", held, "master"]).status, 0);

    const env = { SWARM_HOME: join(f.dir, "home") };
    const config = cliCfg(f.dir);
    const dry = runCli(["prune", f.resultsDir, "--dry-run"], { cwd: f.dir, env, config });
    equal(dry.status, 0, dry.stdout + dry.stderr);
    for (const name of [other, outsidePrefix, unscoped, held]) {
      ok(!dry.stdout.includes(name), `${name} must not be a row: ${dry.stdout}`);
    }
    ok(/has no kept worktrees or branches/.test(dry.stdout), dry.stdout);

    const pruned = runCli(["prune", f.resultsDir], { cwd: f.dir, env, config });
    equal(pruned.status, 0, pruned.stdout + pruned.stderr);
    for (const name of [other, outsidePrefix, unscoped, held]) {
      ok(gitOut(["branch", "--list", name], f.repo), `${name} survives`);
    }
  } finally {
    dropSnapPrune(f);
  }
});

test("row 5: a fan-in run's unchanged source branch, which no tree holds, is pruned with the run", async () => {
  const repo = initGitRepo();
  const dir = schedTmp();
  const resultsDir = join(dir, "run");
  const scope = runScopeKey(resultsDir);
  const config = { worktreeBranchPrefix: "swarm/", treeRoot: join(process.env.SWARM_HOME, "worktrees") };
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      // fix-0 commits; fix-1 legitimately changes nothing, so collect() sweeps its tree
      // and leaves its branch — the leak this plan closes.
      if (cwd.endsWith("fix-0")) {
        writeFileSync(join(cwd, "fix0.txt"), "fix 0\n");
        commitAllInRepo(cwd, "fix 0");
      }
      return { output: "done" };
    });
    await runPlan({
      cwd: repo, resultsDir, concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", branchScope: scope, timeoutMs: 30000 }),
        ...fixCloneTasks(2, { cwd: repo, originalCwd: repo, branchScope: scope }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 30000, after: ["helper", "fix"], worktreeName: "feat", branchScope: scope,
          integrate: { into: "feat", from: ["fix"] } },
      ],
    }, CFG, makeIo(spawn));

    const source = `swarm/${scope}/fix-1`;
    const integrate = `swarm/${scope}/feat`;
    ok(source.startsWith(`swarm/${runScopeKey(resultsDir)}/`), `the fixture's branches are run-scoped: ${source}`);
    ok(gitOut(["branch", "--list", source], repo), "the unchanged source's branch survived collect()");
    ok(!gitOut(["worktree", "list", "--porcelain"], repo).includes("fix-1"), "and its tree was swept");

    // Land the run's work, so the guard has nothing to refuse.
    equal(gitIn(repo, ["merge", "-q", "--ff-only", integrate]).status, 0);

    const env = { SWARM_HOME: process.env.SWARM_HOME };
    const pruned = runCli(["prune", resultsDir], { cwd: dir, env, config });
    equal(pruned.status, 0, pruned.stdout + pruned.stderr);
    equal(gitOut(["branch", "--list", source], repo), "", "the source branch no tree holds is gone");
    equal(gitOut(["branch", "--list", integrate], repo), "", "the integrate branch is gone");
    ok(!existsSync(treeDirFor(resultsDir, "feat", config)), "the integrate tree is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
