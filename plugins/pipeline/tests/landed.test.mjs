import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";

process.env.PIPELINE_SUPPRESS_DEPRECATED = "1";

import { isPrereqLanded } from "../src/orchestrator/landed.mjs";

const PREREQ = "autonomous/pipeline-absorb-phase-3-readers";
const TARGET  = "master";
const ROOT    = "/fake/repo";

// Stub factories
function makeSpawn(responses) {
  // responses: array of { cmd, args_includes, status, stdout }
  return function spawnSync(cmd, args, _opts) {
    for (const r of responses) {
      if (r.cmd && cmd !== r.cmd) continue;
      if (r.args_includes && !args.some(a => a.includes(r.args_includes))) continue;
      return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
}

function makeGh(result) {
  return (_args, _cwd) => result;
}

test("isPrereqLanded: ancestor signal — merge-base returns 0", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 0, stdout: "" },
  ]);
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh: makeGh(null) });
  deepEqual(r, { landed: true, signal: "ancestor" });
});

test("isPrereqLanded: cherry signal — ancestor fails, cherry returns no + lines", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    // cherry returns only "-" lines (all patches present in target)
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "- abc123\n- def456\n" },
  ]);
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh: makeGh(null) });
  deepEqual(r, { landed: true, signal: "cherry" });
});

test("isPrereqLanded: cherry signal — empty stdout (no commits in prereq)", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "" },
  ]);
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh: makeGh(null) });
  deepEqual(r, { landed: true, signal: "cherry" });
});

test("isPrereqLanded: cherry skipped when prereqBranch unknown to git", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 128, stdout: "" },
    // cherry should not be called; ls-remote also not empty → holding
    { cmd: "git", args_includes: "ls-remote", status: 0, stdout: `abc\trefs/heads/${PREREQ}\n` },
  ]);
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh: makeGh(null) });
  deepEqual(r, { landed: false, signal: "none" });
});

test("isPrereqLanded: pr-merged signal — ancestor+cherry negative, gh returns mergedAt", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    // cherry has + lines — not merged via patch content alone
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "+ abc123\n" },
    { cmd: "git", args_includes: "ls-remote", status: 0, stdout: `abc123\trefs/heads/${PREREQ}\n` },
  ]);
  const gh = makeGh([{ mergedAt: "2026-06-15T11:00:00Z" }]);
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh });
  deepEqual(r, { landed: true, signal: "pr-merged" });
});

test("isPrereqLanded: branch-deleted signal — all other checks negative, ls-remote empty", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "+ abc123\n" },
    { cmd: "git", args_includes: "ls-remote", status: 0, stdout: "" },
  ]);
  const gh = makeGh([]);  // no matching merged PR
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh });
  deepEqual(r, { landed: true, signal: "branch-deleted" });
});

test("isPrereqLanded: holding — all probes negative", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "+ abc123\n" },
    { cmd: "git", args_includes: "ls-remote", status: 0, stdout: `abc123\trefs/heads/${PREREQ}\n` },
  ]);
  const gh = makeGh(null);  // gh unavailable
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh });
  deepEqual(r, { landed: false, signal: "none" });
});

test("isPrereqLanded: gh returns empty array — no matched PRs", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "+ abc123\n" },
    { cmd: "git", args_includes: "ls-remote", status: 0, stdout: `abc123\trefs/heads/${PREREQ}\n` },
  ]);
  const gh = makeGh([]);  // empty — no merged PR
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh });
  deepEqual(r, { landed: false, signal: "none" });
});

test("isPrereqLanded: gh returns mergedAt=null — not counted as merged", () => {
  const spawnSync = makeSpawn([
    { cmd: "git", args_includes: "--is-ancestor", status: 1, stdout: "" },
    { cmd: "git", args_includes: "--verify", status: 0, stdout: "abc123\n" },
    { cmd: "git", args_includes: "cherry", status: 0, stdout: "+ abc123\n" },
    { cmd: "git", args_includes: "ls-remote", status: 0, stdout: `abc123\trefs/heads/${PREREQ}\n` },
  ]);
  const gh = makeGh([{ mergedAt: null }]);
  const r = isPrereqLanded(PREREQ, TARGET, ROOT, { spawnSync, gh });
  deepEqual(r, { landed: false, signal: "none" });
});
