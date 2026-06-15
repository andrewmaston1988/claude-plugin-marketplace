import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";

process.env.PIPELINE_SUPPRESS_DEPRECATED = "1";

import { findOpenPR } from "../skills/merge/scripts/merge.mjs";

const BRANCH = "autonomous/feat-x";
const PROJECT = "/fake/repo";

function makeSpawn(responses) {
  return function spawn(_cmd, _args, _opts) {
    const r = responses.shift();
    if (!r) return { status: 1, stdout: "", stderr: "no more responses" };
    return r;
  };
}

test("findOpenPR: returns parsed PR data when gh pr list returns one open PR", () => {
  const spawn = makeSpawn([{
    status: 0,
    stdout: JSON.stringify([{ number: 42, mergeStateStatus: "CLEAN" }]),
    stderr: "",
  }]);
  const pr = findOpenPR(BRANCH, PROJECT, { spawn, log: () => {} });
  deepEqual(pr, { number: 42, mergeStateStatus: "CLEAN" });
});

test("findOpenPR: returns null when gh pr list returns empty array", () => {
  const spawn = makeSpawn([{ status: 0, stdout: "[]", stderr: "" }]);
  const pr = findOpenPR(BRANCH, PROJECT, { spawn, log: () => {} });
  equal(pr, null);
});

test("findOpenPR: returns null when gh pr list exits non-zero (gh not installed)", () => {
  const spawn = makeSpawn([{ status: 1, stdout: "", stderr: "command not found" }]);
  const pr = findOpenPR(BRANCH, PROJECT, { spawn, log: () => {} });
  equal(pr, null);
});

test("findOpenPR: returns null and logs when gh pr list returns malformed JSON", () => {
  const logCalls = [];
  const spawn = makeSpawn([{ status: 0, stdout: "not-json{", stderr: "" }]);
  const pr = findOpenPR(BRANCH, PROJECT, { spawn, log: m => logCalls.push(m) });
  equal(pr, null);
  equal(logCalls.length, 1);
  ok(logCalls[0].includes("non-JSON"), "log line should mention non-JSON parse failure");
});

test("findOpenPR: passes --head <branch> and --state open to gh", () => {
  let captured;
  const spawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { status: 0, stdout: "[]", stderr: "" };
  };
  findOpenPR(BRANCH, PROJECT, { spawn, log: () => {} });
  equal(captured.cmd, "gh");
  ok(captured.args.includes("--head"), "should pass --head flag");
  ok(captured.args.includes(BRANCH), "should include branch name");
  ok(captured.args.includes("--state"), "should pass --state flag");
  ok(captured.args.includes("open"), "should filter to open state");
  ok(captured.args.includes("--json"), "should request JSON output");
});
