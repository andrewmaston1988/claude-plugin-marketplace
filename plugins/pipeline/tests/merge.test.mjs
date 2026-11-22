// merge.mjs — step 5 routing: PR-first, then hook, then local.
//
// Plan merge-skip-hook-for-pr: when an open PR exists, merge.mjs MUST use
// `gh pr merge <number> --squash --admin` directly regardless of whether
// `hooks.on_merge` is configured. Operator hooks are unreliable for PR
// merges (branch-name disambiguation + missing --admin on branch-protected
// repos). These tests inject a fake `spawn` so we can observe exactly which
// gh commands step5 issues, and override USERPROFILE so loadPipelineConfig
// reads a fake config.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { ok, equal, deepEqual, rejects } from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { connectPath, close, projectAdd, rowAdd, rowUpdate } from "../src/db/index.mjs";

// Record GH calls without running the CLI. Other commands still run locally.
function makeFakeSpawn({ prList = [], failMerge = false } = {}) {
  const calls = [];
  function fakeSpawn(cmd, args, opts) {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(prList), stderr: "" };
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "merge") {
      return { status: failMerge ? 1 : 0, stdout: "", stderr: failMerge ? "boom" : "" };
    }
    if (cmd === "gh") throw new Error(`Unexpected gh command: ${args.join(" ")}`);
    return spawnSync(cmd, args, { ...opts, encoding: opts?.encoding ?? "utf8" });
  }
  fakeSpawn.calls = calls;
  return fakeSpawn;
}

function makeGitRepo(repo, { target = "master", feature = "feat-x" } = {}) {
  const init = spawnSync("git", ["-C", repo, "init", "--initial-branch=" + target], { encoding: "utf8" });
  if (init.status !== 0) throw new Error("git init failed: " + init.stderr);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@test"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "test"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "commit.gpgsign", "false"], { encoding: "utf8" });
  writeFileSync(join(repo, "README.md"), "init\n");
  spawnSync("git", ["-C", repo, "add", "README.md"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "init"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "checkout", "-b", `autonomous/${feature}`], { encoding: "utf8" });
  writeFileSync(join(repo, "feature.txt"), "feat\n");
  spawnSync("git", ["-C", repo, "add", "feature.txt"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "feat"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "checkout", target], { encoding: "utf8" });
}

// Override USERPROFILE so loadPipelineConfig reads our fake config.
// Returns a teardown function that restores the original.
function withFakeHome(tmp) {
  const configDir = join(tmp, ".pipeline");
  mkdirSync(configDir, { recursive: true });
  const origUserProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;
  process.env.USERPROFILE = tmp;
  process.env.HOME = tmp;
  return {
    writeConfig(cfg) {
      writeFileSync(join(configDir, "config.json"), JSON.stringify(cfg), "utf8");
    },
    restore() {
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    },
  };
}

// ── Test 1: PR exists + hook configured → gh pr merge <number> --squash --admin,
//             hook NOT called. ──────────────────────────────────────────────────
test("step5: open PR + on_merge hook → uses gh pr merge directly, bypasses hook", async () => {
  const repoTmp = mkdtempSync(join(tmpdir(), "merge-step5-repo-"));
  const cfgTmp = mkdtempSync(join(tmpdir(), "merge-step5-cfg-"));
  let hookCalledPath;
  try {
    makeGitRepo(repoTmp, { target: "master", feature: "feat-x" });

    // Write a hook script that, if called, would create a marker file.
    // resolveHookFirstToken returns the raw string when the head is not
    // path-like; we use a bare command name and put the script on PATH so
    // spawnSync(process.execPath, [hookPath]) finds it... but merge.mjs
    // uses spawnSync(process.execPath, [hookPath]) so the hookPath must
    // be a file path, not a command name. So write a real file path and
    // check the marker.
    hookCalledPath = join(cfgTmp, "hook-called.marker");
    const hookPath = join(cfgTmp, "fake-hook.mjs");
    writeFileSync(hookPath, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(hookCalledPath)}, 'called', 'utf8');`,
    ].join("\n"), "utf8");

    const home = withFakeHome(cfgTmp);
    home.writeConfig({ hooks: { on_merge: hookPath } });

    const { step5SquashMerge } = await import("../skills/merge/scripts/merge.mjs");
    const fakeSpawn = makeFakeSpawn({ prList: [{ number: 99, mergeStateStatus: "CLEAN" }] });

    let thrown;
    try {
      await step5SquashMerge(null, "testproj", repoTmp, ["autonomous/feat-x"], {}, "master", { spawn: fakeSpawn });
    } catch (e) {
      thrown = e;
    } finally {
      home.restore();
    }

    equal(thrown, undefined, `step5 should not throw; stderr=${thrown?.message}`);
    const ghCalls = fakeSpawn.calls.filter(c => c.cmd === "gh");
    const mergeCalls = ghCalls.filter(c => c.args[0] === "pr" && c.args[1] === "merge");
    equal(mergeCalls.length, 1, "exactly one gh pr merge call expected");
    const args = mergeCalls[0].args;
    ok(args.includes("99"), "gh pr merge should be called with PR number 99");
    ok(args.includes("--squash"), "gh pr merge should pass --squash");
    ok(args.includes("--admin"), "gh pr merge should pass --admin");
    ok(!existsSync(hookCalledPath), "operator hook must NOT have been called when PR exists");
  } finally {
    rmSync(repoTmp, { recursive: true, force: true });
    rmSync(cfgTmp, { recursive: true, force: true });
  }
});

// ── Test 2: no PR + hook configured → hook IS called (existing local path). ──
test("step5 runs the on_merge hook with the project root as cwd and in its environment", async () => {
  const repoTmp = mkdtempSync(join(tmpdir(), "merge-step5-repo-"));
  const cfgTmp = mkdtempSync(join(tmpdir(), "merge-step5-cfg-"));
  let hookCalledPath;
  try {
    makeGitRepo(repoTmp, { target: "master", feature: "feat-y" });

    hookCalledPath = join(cfgTmp, "hook-called.marker");
    const hookPath = join(cfgTmp, "fake-hook.mjs");
    writeFileSync(hookPath, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(hookCalledPath)}, JSON.stringify({ cwd: process.cwd(), root: process.env.PIPELINE_PROJECT_ROOT }));`,
    ].join("\n"), "utf8");

    const home = withFakeHome(cfgTmp);
    home.writeConfig({ hooks: { on_merge: hookPath } });

    const { step5SquashMerge } = await import("../skills/merge/scripts/merge.mjs");
    // Empty PR list — findOpenPR returns null → hook path triggers.
    const fakeSpawn = makeFakeSpawn({ prList: [] });

    let thrown;
    try {
      await step5SquashMerge(null, "testproj", repoTmp, ["autonomous/feat-y"], {}, "master", { spawn: fakeSpawn });
    } catch (e) {
      thrown = e;
    } finally {
      home.restore();
    }

    equal(thrown, undefined, `step5 should not throw; stderr=${thrown?.message}`);
    deepEqual(JSON.parse(readFileSync(hookCalledPath, "utf8")), { cwd: repoTmp, root: repoTmp });
    const ghCalls = fakeSpawn.calls.filter(c => c.cmd === "gh");
    const mergeCalls = ghCalls.filter(c => c.args[0] === "pr" && c.args[1] === "merge");
    equal(mergeCalls.length, 0, "no gh pr merge call expected when no PR exists");
  } finally {
    rmSync(repoTmp, { recursive: true, force: true });
    rmSync(cfgTmp, { recursive: true, force: true });
  }
});

// ── Test 3: no PR + no hook → local squash-merge path runs. ──────────────────
test("step5: no open PR + no hook → local squash-merge path runs", async () => {
  const repoTmp = mkdtempSync(join(tmpdir(), "merge-step5-repo-"));
  const cfgTmp = mkdtempSync(join(tmpdir(), "merge-step5-cfg-"));
  try {
    makeGitRepo(repoTmp, { target: "master", feature: "feat-z" });

    const home = withFakeHome(cfgTmp);
    home.writeConfig({ hooks: {} }); // no on_merge hook

    const { step5SquashMerge } = await import("../skills/merge/scripts/merge.mjs");
    const fakeSpawn = makeFakeSpawn({ prList: [] });

    let thrown;
    try {
      await step5SquashMerge(null, "testproj", repoTmp, ["autonomous/feat-z"], {}, "master", { spawn: fakeSpawn });
    } catch (e) {
      thrown = e;
    } finally {
      home.restore();
    }

    equal(thrown, undefined, `step5 should not throw; stderr=${thrown?.message}`);
    const ghCalls = fakeSpawn.calls.filter(c => c.cmd === "gh");
    const mergeCalls = ghCalls.filter(c => c.args[0] === "pr" && c.args[1] === "merge");
    equal(mergeCalls.length, 0, "no gh pr merge call expected on local path");
    // The local path runs a real git squash + commit; verify a commit landed.
    const log = spawnSync("git", ["-C", repoTmp, "log", "--oneline", "-1"], { encoding: "utf8" });
    ok(log.stdout.includes("feat") || log.stdout.includes("Merge"), `expected squash-merge commit; got: ${log.stdout}`);
  } finally {
    rmSync(repoTmp, { recursive: true, force: true });
    rmSync(cfgTmp, { recursive: true, force: true });
  }
});

test("step5 identifies the worktree holding the target branch", async (t) => {
  const { tmp, repo } = makeRepoDir();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  makeGitRepo(repo);
  const other = join(tmp, "other checkout").replaceAll("\\", "/");
  gitFixture(repo, "checkout", "--detach");
  gitFixture(repo, "worktree", "add", other, "master");
  const { step5SquashMerge } = await import("../skills/merge/scripts/merge.mjs");
  const stderr = t.mock.method(process.stderr, "write", () => true);
  await rejects(step5SquashMerge(null, "registered-project", repo, [], {}, "master"));
  const blocker = stderr.mock.calls[0].arguments[0];
  stderr.mock.restore();

  ok(blocker.includes(`'master' is checked out in '${other}'`), blocker);
});

test("step5 cleans up the registered project's feature worktree", async (t) => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const config = withFakeHome(home);
  t.after(() => config.restore());
  config.writeConfig({ worktree_base: "{root_parent}/trees/{project}/{feature}" });
  makeGitRepo(repo);
  const worktree = join(tmp, "trees", "registered-project", "feat-x");
  gitFixture(repo, "worktree", "add", worktree, "autonomous/feat-x");

  const { step5SquashMerge } = await import("../skills/merge/scripts/merge.mjs");
  await step5SquashMerge(null, "registered-project", repo, ["autonomous/feat-x"], {}, "master", {
    spawn: makeFakeSpawn(),
  });

  ok(!existsSync(worktree), "feature worktree should be removed");
  equal(gitFixture(repo, "branch", "--list", "autonomous/feat-x"), "");
});

function gitFixture(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout.trim();
}

// ── Exit-code contract: a failed merge must never exit 0 ──────────────────────
//
// Callers branch on merge.mjs's exit code — run-merge.mjs hands the invocation to
// a background agent, hooks and sessions read it directly. Every failure path
// must exit non-zero with the failure on stderr, and must not print the success
// line. Exit 0 after a rollback reads as "landed" when nothing did.

const MERGE_MJS = fileURLToPath(new URL("../skills/merge/scripts/merge.mjs", import.meta.url));
const SUCCESS_LINE = "merge.mjs — complete";

const PLAN_MIN = "# feat-x\n\n## Goal\n\nLand feat-x.\n\n## Current Status\n\n- in progress\n";
const FAILING_SMOKE = "# Repo\n\n## Smoke check\n\n```bash\nexit 9\n```\n";

// getPaths() derives config.json AND pipeline.db from the home dir, so an
// isolated home keeps the real ~/.pipeline out of the test. On Linux it reads
// the XDG dirs instead, so those are dropped and the DB sits under ~/.local/share.
function dbFile(home) {
  return process.platform === "linux"
    ? join(home, ".local", "share", "pipeline", "pipeline.db")
    : join(home, ".pipeline", "pipeline.db");
}

function homeEnv(home) {
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete env[k];
  return env;
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "merge-exit-home-"));
  mkdirSync(dirname(dbFile(home)), { recursive: true });
  return home;
}

// Unregistered checkouts use their directory name, which must be a valid project name.
function makeRepoDir() {
  const tmp = mkdtempSync(join(tmpdir(), "merge-exit-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  return { tmp, repo };
}

// master carries the seed files; the feature branch is one commit ahead of it so
// step 5 takes the squash path rather than the already-integrated one.
function makeMergeRepo(dir, { feature = "feat-x", plan = null, claudeMd = null } = {}) {
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "--initial-branch=master");
  git("config", "user.email", "test@test");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "init\n");
  if (plan) {
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(join(dir, "plans", `${feature}.md`), plan, "utf8");
  }
  if (claudeMd) writeFileSync(join(dir, "CLAUDE.md"), claudeMd, "utf8");
  git("add", "-A");
  git("commit", "-m", "seed");
  git("checkout", "-b", `autonomous/${feature}`);
  writeFileSync(join(dir, "feature.txt"), "feat\n");
  git("add", "feature.txt");
  git("commit", "-m", "feat");
  git("checkout", "master");
  return dir;
}

function runMerge(repo, home, branches, extraArgs = []) {
  return spawnSync(process.execPath, [
    MERGE_MJS, "--branches", branches, "--project-dir", repo,
    "--target-branch", "master", ...extraArgs,
  ], {
    env: homeEnv(home),
    encoding: "utf8",
    timeout: 60_000,
  });
}

function seedRow(home, repo, { project = basename(repo), feature = "feat-x", stage, qaPass = null } = {}) {
  const db = connectPath(dbFile(home));
  try {
    projectAdd(db, { name: project, rootPath: repo });
    rowAdd(db, project, {
      feature,
      planFile: join(repo, "plans", `${feature}.md`),
      stage,
    });
    if (qaPass !== null) rowUpdate(db, project, feature, { qa_pass: qaPass });
  } finally { close(db); }
}

test("step0a rebases in the registered project's feature worktree", (t) => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  makeMergeRepo(repo, { plan: PLAN_MIN });
  const project = "registered-project";
  seedRow(home, repo, { project, stage: "queued" });
  const worktree = join(tmp, ".worktrees", project, "feat-x");
  gitFixture(repo, "worktree", "add", worktree, "autonomous/feat-x");
  gitFixture(repo, "commit", "--allow-empty", "-m", "Advance master");
  const r = runMerge(repo, home, "autonomous/feat-x");

  equal(r.status, 4, `expected rebase success followed by the DoD blocker: ${r.stdout}\n${r.stderr}`);
  ok(r.stderr.includes("pipeline stage is 'queued'"), r.stderr);
  equal(gitFixture(worktree, "rev-parse", "HEAD^"), gitFixture(repo, "rev-parse", "HEAD"));
});

test("merge.mjs: step 0a failure exits non-zero, prints no success line", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeMergeRepo(repo, { feature: "feat-x" });
    const r = runMerge(repo, home, "autonomous/ghost-branch");

    equal(r.status, 3, `step 0a failure must exit 3; stdout=${r.stdout} stderr=${r.stderr}`);
    ok(!r.stdout.includes(SUCCESS_LINE), `success line printed on a failed merge: ${r.stdout}`);
    ok(/BLOCKER/.test(r.stderr), `failure not reported on stderr: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("merge.mjs: step 2 blocker exits non-zero (after rollback), no success line", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeMergeRepo(repo, { feature: "feat-x", plan: PLAN_MIN });
    seedRow(home, repo, { stage: "queued" });
    const r = runMerge(repo, home, "autonomous/feat-x", ["--no-rebase"]);

    equal(r.status, 4, `DoD blocker must exit 4; stdout=${r.stdout} stderr=${r.stderr}`);
    ok(!r.stdout.includes(SUCCESS_LINE), `success line printed on a blocked merge: ${r.stdout}`);
    ok(/BLOCKER: autonomous\/feat-x: pipeline stage/.test(r.stderr),
      `blocker not reported on stderr: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("merge.mjs: failed smoke check exits non-zero, no success line", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeMergeRepo(repo, { feature: "feat-x", plan: PLAN_MIN, claudeMd: FAILING_SMOKE });
    seedRow(home, repo, { stage: "merge", qaPass: 1 });
    const r = runMerge(repo, home, "autonomous/feat-x", ["--no-rebase"]);

    equal(r.status, 5, `smoke failure must exit 5; stdout=${r.stdout} stderr=${r.stderr}`);
    ok(!r.stdout.includes(SUCCESS_LINE), `success line printed on a failed merge: ${r.stdout}`);
    ok(/BLOCKER: smoke check failed/.test(r.stderr), `smoke failure not on stderr: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// The contract only holds if the clean path is untouched: same exit code, same
// success line, one commit on the target.
test("merge.mjs: successful local merge still exits 0 and prints the success line", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeMergeRepo(repo, { feature: "feat-x", plan: PLAN_MIN });
    seedRow(home, repo, { stage: "merge", qaPass: 1 });
    const before = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const r = runMerge(repo, home, "autonomous/feat-x", ["--no-rebase"]);

    equal(r.status, 0, `clean merge must exit 0; stderr=${r.stderr}`);
    ok(r.stdout.includes(SUCCESS_LINE), `success line missing: ${r.stdout}`);
    const after = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    ok(after !== before, "successful merge should land a commit on the target branch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
// Operator, 2026-09-24: a local merge pushes. Unpushed, the next sync to origin
// discards it silently — the squash and the plan-close commit both.
function addOrigin(tmp, repo, url = null) {
  const bare = url ?? join(tmp, "origin.git");
  if (!url) spawnSync("git", ["init", "--bare", "--initial-branch=master", bare], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "remote", "add", "origin", bare], { encoding: "utf8" });
  if (!url) spawnSync("git", ["-C", repo, "push", "origin", "master"], { encoding: "utf8" });
  return bare;
}

test("merge.mjs: a local merge pushes the target, so origin holds every commit it made", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeMergeRepo(repo, { feature: "feat-x", plan: PLAN_MIN });
    const bare = addOrigin(tmp, repo);
    seedRow(home, repo, { stage: "merge", qaPass: 1 });
    const r = runMerge(repo, home, "autonomous/feat-x", ["--no-rebase"]);

    equal(r.status, 0, `clean merge must exit 0; stderr=${r.stderr}`);
    const local = spawnSync("git", ["-C", repo, "rev-parse", "master"], { encoding: "utf8" }).stdout.trim();
    const remote = spawnSync("git", ["-C", bare, "rev-parse", "master"], { encoding: "utf8" }).stdout.trim();
    equal(remote, local, "origin's master must match local master after the merge");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("merge.mjs: a failed push exits 7 and keeps the local merge", () => {
  const { tmp, repo } = makeRepoDir();
  const home = makeHome();
  try {
    makeMergeRepo(repo, { feature: "feat-x", plan: PLAN_MIN });
    addOrigin(tmp, repo, join(tmp, "no-such-remote.git"));
    seedRow(home, repo, { stage: "merge", qaPass: 1 });
    const before = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const r = runMerge(repo, home, "autonomous/feat-x", ["--no-rebase"]);

    equal(r.status, 7, `push failure must exit 7; stdout=${r.stdout} stderr=${r.stderr}`);
    ok(!r.stdout.includes(SUCCESS_LINE), `success line printed on an unpushed merge: ${r.stdout}`);
    ok(/BLOCKER: push/.test(r.stderr), `push failure not on stderr: ${r.stderr}`);
    const after = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    ok(after !== before, "the merge landed locally and must not be rolled back");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanupBranch: a branch already gone (a hook deleted it) is skipped, not reported as a failed delete", async () => {
  const { tmp, repo } = makeRepoDir();
  try {
    makeMergeRepo(repo, { feature: "feat-x" });
    spawnSync("git", ["-C", repo, "branch", "-D", "autonomous/feat-x"], { encoding: "utf8" });
    const { cleanupBranch } = await import("../skills/merge/scripts/land.mjs");
    const errs = [];
    await cleanupBranch(repo, "autonomous/feat-x", join(tmp, "no-worktree"), { log: () => {}, err: (m) => errs.push(m) });
    equal(errs.length, 0, `no warning for a branch that is already gone: ${errs}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
