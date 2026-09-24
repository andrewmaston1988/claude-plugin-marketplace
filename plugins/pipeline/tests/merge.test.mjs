// merge.mjs — step 5 routing: PR-first, then hook, then local.
//
// Plan merge-skip-hook-for-pr: when an open PR exists, merge.mjs MUST use
// `gh pr merge <number> --squash --admin` directly regardless of whether
// `hooks.on_merge` is configured. Operator hooks are unreliable for PR
// merges (branch-name disambiguation + missing --admin on branch-protected
// repos). These tests inject a fake `spawn` so we can observe exactly which
// gh commands step5 issues, and override USERPROFILE so loadPipelineConfig
// reads a fake config.
import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { connectPath, close, projectAdd, rowAdd, rowUpdate } from "../src/db/index.mjs";

// Capture every gh-related spawn call; let everything else (git) fall
// through to real spawnSync. The caller provides a PR list response that
// `findOpenPR` will receive.
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
    if (cmd === "gh") {
      // unknown gh subcommand — let real gh handle it (uncommon in step5)
      return spawnSync(cmd, args, { ...opts, encoding: opts?.encoding ?? "utf8" });
    }
    // git or anything else — real spawnSync
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
test("step5: no open PR + on_merge hook → hook is invoked (regression guard)", async () => {
  const repoTmp = mkdtempSync(join(tmpdir(), "merge-step5-repo-"));
  const cfgTmp = mkdtempSync(join(tmpdir(), "merge-step5-cfg-"));
  let hookCalledPath;
  try {
    makeGitRepo(repoTmp, { target: "master", feature: "feat-y" });

    hookCalledPath = join(cfgTmp, "hook-called.marker");
    const hookPath = join(cfgTmp, "fake-hook.mjs");
    writeFileSync(hookPath, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(hookCalledPath)}, 'called', 'utf8');`,
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
    ok(existsSync(hookCalledPath), "operator hook SHOULD have been called when no PR exists");
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
// isolated home keeps the real ~/.pipeline out of the test.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "merge-exit-home-"));
  mkdirSync(join(home, ".pipeline"), { recursive: true });
  return home;
}

// merge.mjs takes the project name from basename(projectDir), and project names
// are validated as [a-z0-9][a-z0-9_-]* — so the repo dir must be a fixed,
// lowercase name inside the tmpdir, not the mkdtemp basename.
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
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function seedRow(home, repo, { feature = "feat-x", stage, qaPass = null } = {}) {
  const db = connectPath(join(home, ".pipeline", "pipeline.db"));
  try {
    const project = basename(repo);
    projectAdd(db, { name: project, rootPath: repo });
    rowAdd(db, project, {
      feature,
      planFile: join(repo, "plans", `${feature}.md`),
      stage,
    });
    if (qaPass !== null) rowUpdate(db, project, feature, { qa_pass: qaPass });
  } finally { close(db); }
}

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