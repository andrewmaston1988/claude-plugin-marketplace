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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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