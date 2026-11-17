// Rows 10-12: a lane ported into a feature branch that later landed is pruned by the
// taken record, every unprovable case stays kept with its reason named, and the port
// nudge counts the same lane once the squash lands.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { appendTaken } from "../src/taken.mjs";
import { defaultBranchName } from "../src/landed.mjs";
import { runPortNudge } from "../src/port-nudge.mjs";
import { git, must, takenFixture, publishDefault } from "./helpers/port-fixture.mjs";
import { runCliInProcess } from "./helpers/cli.mjs";

const SESSION = "sess-taken";

const withFixture = async (fn, opts) => {
  const f = takenFixture(opts);
  try { return await fn(f); } finally { f.cleanup(); }
};

// The record the port hook writes: `portCommit` is the pick, `intoTip` the last commit it
// saw on the branch — the review commit, which is the branch's tip when it is deleted.
const recordPort = (f, over = {}) => appendTaken({
  home: f.home,
  toplevel: f.toplevel,
  fs,
  records: [{
    run: f.runName,
    branch: f.lane.branch,
    laneTip: f.lane.tip,
    repo: f.repo,
    into: f.branch,
    portCommit: f.picks[1],
    intoTip: f.portTip,
    ...over,
  }],
});

const prune = async (f, args = []) => runCliInProcess(["prune", ...args, f.runDir], { cwd: f.repo, env: { SWARM_HOME: f.home } });

test("row 10: a lane ported then superseded is pruned without --discard-unlanded", () => withFixture(async (f) => {
  recordPort(f);
  publishDefault(f.repo);
  const r = await prune(f);
  equal(r.status, 0, r.stderr);
  ok(r.stdout.includes("freed"), r.stdout);
  equal(fs.existsSync(f.lane.path), false, "the lane worktree is gone");
  equal(git(["rev-parse", "--verify", "--quiet", `refs/heads/${f.lane.branch}`], f.repo).status, 1,
    "the lane branch is gone");
}));

test("row 10: with the taken log deleted the same lane is kept as today", () => withFixture(async (f) => {
  recordPort(f);
  fs.rmSync(join(f.home, "taken"), { recursive: true, force: true });
  const r = await prune(f);
  equal(r.status, 1);
  ok(r.stderr.includes("unlanded"), r.stderr);
  ok(fs.existsSync(f.lane.path), "without the proof the lane is kept");
}));

test("row 11: an unproved port keeps the lane, naming why", () => withFixture(async (f) => {
  recordPort(f);
  // The branch was never merged: main still sits where the squash landed on. Published
  // after the reset, so this row exercises "not merged", not "no default branch".
  must(["reset", "--hard", `${f.squash}^`], f.repo);
  publishDefault(f.repo);
  equal(defaultBranchName(f.git, f.repo), "main", "precondition: the repo names a default branch");
  const abandoned = await prune(f, ["--dry-run"]);
  ok(abandoned.stdout.includes(`taken into \`${f.branch}\`; \`${f.branch}\` not landed yet`), abandoned.stdout);
  ok(fs.existsSync(f.lane.path), "the unproved lane is kept");

  // And once git has dropped the recorded tip, the record proves even less.
  must(["reflog", "expire", "--expire=now", "--all"], f.repo);
  must(["gc", "--prune=now"], f.repo);
  // The fixture must really have dropped the tip, or this half would pass on a live object.
  equal(git(["rev-parse", "--verify", "--quiet", `${f.portTip}^{commit}`], f.repo).status, 1);
  const gone = await prune(f, ["--dry-run"]);
  ok(gone.stdout.includes("the recorded tip is gone"), gone.stdout);
  ok(fs.existsSync(f.lane.path), "the unproved lane is kept");
}));

test("row 11: a lane with no record keeps today's message", () => withFixture(async (f) => {
  const r = await prune(f, ["--dry-run"]);
  ok(r.stdout.includes("2 unlanded"), r.stdout);
  equal(r.stdout.includes("taken into"), false, "no taken reason without a record");
}));

// The nudge measures through plan() with the same taken map, so the squash that landed
// the port is also what lets a HEAD-moving command name the run from the main checkout.
test("row 12: the port nudge counts a taken lane once the squash lands", () => withFixture(async (f) => {
  recordPort(f);
  publishDefault(f.repo);
  const out = runPortNudge({
    payload: {
      session_id: SESSION,
      cwd: f.repo,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git commit -m landed" },
    },
    env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs, budgetMs: 120_000,
  });
  ok(out !== "", "the run is reported, not held back as unlanded");
  const line = JSON.parse(out).hookSpecificOutput.additionalContext;
  ok(line.includes(`\`${f.runName}\` is ported`), line);
  ok(line.includes(`landed in \`main\`@\`${f.squash.slice(0, 7)}\``), line);
}, { launcher: SESSION }));
