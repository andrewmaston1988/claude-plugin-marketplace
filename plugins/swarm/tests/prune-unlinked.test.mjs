// The unlinked-leftover path at unit level: what is held back, what is cleared, and what
// is measured. The CLI rows that drive the same path end to end live in
// cli-prune-unlinked.test.mjs.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { plan, execute, blockers, isHeldBack } from "../src/prune.mjs";

test("isHeldBack: one predicate for the leftover directory prune will not clear, and blockers agrees with it", () => {
  equal(isHeldBack({ unlinked: true, entries: 1 }), true);
  equal(isHeldBack({ unlinked: true, entries: 0 }), false);
  equal(isHeldBack({ unlinked: false, entries: 3 }), false);
  equal(isHeldBack({ path: "/r/wt", entries: 0 }), false);
  const held = { path: "/r/wt", unlinked: true, entries: 1, unlanded: 0, dirty: 0 };
  deepEqual(blockers([held]), [held], "blockers must hold back exactly what isHeldBack names");
});

test("execute: an unlinked leftover already gone is cleared, not a failure; a refusal reports its own code", () => {
  const row = { path: "/results/wt-gone", branch: "swarm/k/leaf", repo: "/repo", unlinked: true, entries: 0, bytes: 0, dirty: 0, unlanded: 0 };
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  let rmdirOpts = "unset";
  const vanished = {
    existsSync: () => true,
    rmdirSync: (p, opts) => { rmdirOpts = opts; const e = new Error("gone"); e.code = "ENOENT"; throw e; },
  };
  const { failed } = execute([row], git, vanished);
  equal(rmdirOpts, undefined, "rmdirSync accepts no options — { force } is inert");
  deepEqual(failed, [], "a directory that vanished between plan and execute is already cleared");
  deepEqual(calls.at(-1), { args: ["branch", "-D", "swarm/k/leaf"], cwd: "/repo" }, "the branch is still deleted");

  const blockedCalls = [];
  const blockedGit = (args, cwd) => { blockedCalls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  const full = { existsSync: () => true, rmdirSync: () => { const e = new Error("not empty"); e.code = "ENOTEMPTY"; throw e; } };
  const refused = execute([row], blockedGit, full);
  equal(refused.failed.length, 1);
  ok(refused.failed[0].reason.includes("ENOTEMPTY"), `the real code must be reported: ${refused.failed[0].reason}`);
  ok(!blockedCalls.some(({ args }) => args[0] === "branch"), "a directory prune could not clear keeps its branch");
});

test("row 23: an unlinked row that is held back is never walked for bytes", () => {
  const walked = [];
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-held",
    readdirSync: (p, opts) => {
      if (p === "/results/wt-held" && !opts) return ["leftover.txt"];
      walked.push({ p, opts });
      return [];
    },
    statSync: () => ({ size: 0 }),
  };
  const git = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { status: 0, stdout: "/elsewhere", stderr: "" };
    if (args[0] === "worktree") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "show-ref") return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "for-each-ref") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const run = {
    repos: ["/repo"],
    resultsDir: "/results",
    worktreesKept: [{ name: "impl", path: "/results/wt-held", branch: "swarm/k/leaf", repo: "/repo" }],
  };
  const { rows } = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(rows.length, 1);
  equal(rows[0].unlinked, true);
  equal(rows[0].entries, 1);
  equal(rows[0].bytes, 0, "a held-back row prints no size, so it measures none");
  deepEqual(walked, [], "no recursive walk over a directory prune will not clear");
});
