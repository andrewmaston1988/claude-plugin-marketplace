// The taken log: append-only proof, recorded while the port exists, read later while
// landing is decided against the default branch alone.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, statSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { takenLogPath, appendTaken, readTaken, refreshTaken, takenVerdict } from "../src/taken.mjs";
import { portFixture, must, writeCommit } from "./helpers/port-fixture.mjs";

const PREFIX = "swarm/";
const MAX = 1024 * 1024;

const rec = (over = {}) => ({
  run: "run-a",
  branch: "swarm/run-a/leaf",
  laneTip: "a".repeat(40),
  repo: "/repo",
  into: "feature",
  portCommit: "b".repeat(40),
  intoTip: "c".repeat(40),
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

function withFixture(fn) {
  const f = portFixture();
  try { return fn(f); } finally { f.cleanup(); }
}

const runDir = (f, name) => mkdirSync(join(f.runsRoot, name), { recursive: true });
const logLines = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);

test("row 5: readTaken keeps the newest line per (run, lane) across .1 and the log", () => withFixture((f) => {
  for (const name of ["run-a", "run-b"]) runDir(f, name);
  const log = takenLogPath(f.home, f.toplevel);

  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [
    rec({ intoTip: "old", branch: "swarm/run-a/leaf" }),
    rec({ run: "run-b", branch: "swarm/run-b/leaf", intoTip: "only-b" }),
    rec({ run: "run-gone", branch: "swarm/run-gone/leaf" }),
  ] });
  renameSync(log, `${log}.1`);
  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [rec({ intoTip: "new" })] });

  const map = readTaken({ home: f.home, toplevel: f.toplevel, fs });
  equal(map.get("run-a\nswarm/run-a/leaf").intoTip, "new", "the live log wins over the rotation");
  equal(map.get("run-b\nswarm/run-b/leaf").intoTip, "only-b", "a line only the rotation holds is still read");
  equal(map.has("run-gone\nswarm/run-gone/leaf"), false, "a run whose dir is gone is history, not a record");

  const before = readFileSync(log, "utf8");
  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [rec({ run: "run-b", branch: "swarm/run-b/other" })] });
  ok(readFileSync(log, "utf8").startsWith(before), "an append never rewrites an earlier line");
}));

test("row 6: refreshTaken moves only records on the branch, along descent", () => withFixture((f) => {
  const b = f.porting("b6", "feature");
  writeCommit(b, "f1.txt", "1\n", "c1");
  const c1 = must(["rev-parse", "HEAD"], b);
  writeCommit(b, "f2.txt", "2\n", "c2");
  const c2 = must(["rev-parse", "HEAD"], b);
  writeCommit(b, "f3.txt", "3\n", "c3");
  const c3 = must(["rev-parse", "HEAD"], b);
  for (const name of ["run-a", "run-b", "run-c"]) runDir(f, name);

  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [
    rec({ intoTip: c1, portCommit: "port" }),
    rec({ run: "run-b", branch: "swarm/run-b/leaf", into: "other", intoTip: c1 }),
    rec({ run: "run-c", branch: "swarm/run-c/leaf", intoTip: c3 }),
  ] });
  const log = takenLogPath(f.home, f.toplevel);
  const lines = logLines(log).length;

  refreshTaken({ home: f.home, toplevel: f.toplevel, into: "feature", head: c2, git: f.git, fs });

  const map = readTaken({ home: f.home, toplevel: f.toplevel, fs });
  const a = map.get("run-a\nswarm/run-a/leaf");
  equal(a.intoTip, c2, "a descendant head moves intoTip");
  equal(a.portCommit, "port", "portCommit is the original witness and never changes");
  equal(map.get("run-b\nswarm/run-b/leaf").intoTip, c1, "another branch's record is untouched");
  equal(map.get("run-c\nswarm/run-c/leaf").intoTip, c3, "a head below intoTip is a reset, not a refresh");
  equal(logLines(log).length, lines + 1, "exactly one refresh line is appended");

  refreshTaken({ home: f.home, toplevel: f.toplevel, into: "feature", head: c2, git: f.git, fs });
  equal(logLines(log).length, lines + 1, "an unchanged tip appends nothing");
}));

test("row 7: takenVerdict reads the target's tip, then the recorded tip, against the default branch", () => withFixture((f) => {
  const lane = f.leaf("run7", "leaf");
  const b = f.porting("b7", "feature");
  const pick = f.cherryPick(b, lane.sha);
  // The reported shape: review rewrites the lane's own lines, so the pick no longer
  // merges cleanly into the branch that later lands.
  writeCommit(b, "run7-leaf.txt", "rewritten by review\n", "review edit");
  const review = must(["rev-parse", "HEAD"], b);
  must(["merge", "-q", "--squash", "feature"], f.repo);
  must(["commit", "-qm", "squash feature"], f.repo);
  const verdict = (record, laneTip = lane.sha, gitRunner = f.git) =>
    takenVerdict({ record, laneTip, repo: f.toplevel, prefix: PREFIX, gitRunner });

  // intoTip is the bare pick, which main never absorbs: landing here proves the
  // target's own tip was the candidate.
  const record = rec({ run: "run7", branch: lane.branch, laneTip: lane.sha, into: "feature", portCommit: pick, intoTip: pick });
  equal(verdict(record).landed, true, "the target's tip descends from portCommit and is landed");
  equal(verdict({ ...record, into: "no-such-branch" }).landed, false,
    "precondition: the recorded pick alone is not landed on the default branch");

  must(["worktree", "remove", "--force", b], f.repo);
  must(["branch", "-D", "feature"], f.repo);
  equal(verdict({ ...record, intoTip: review }).landed, true, "the recorded tip carries the verdict once the branch is gone");

  const gone = verdict({ ...record, intoTip: "1234567890abcdef1234567890abcdef12345678" });
  equal(gone.landed, false, "a tip that no longer resolves is not landed");
  ok(/gone/.test(gone.reason), `the reason names the missing tip: ${gone.reason}`);

  // The recorded tip is a landed one, so only the laneTip comparison can refuse this.
  equal(verdict({ ...record, intoTip: review }, "f".repeat(40)).landed, false,
    "a lane that moved after the record is not landed");
  const broken = (args, cwd, opts) => (args[0] === "diff" ? { status: 0, stdout: "", stderr: "" } : { status: 128, stdout: "", stderr: "boom" });
  const errored = verdict({ ...record, intoTip: review }, lane.sha, broken);
  equal(errored.landed, false, "any git error reads not landed");
}));

test("row 13b: a recreated target does not inherit the record", () => withFixture((f) => {
  const lane = f.leaf("run13", "leaf");
  const b = f.porting("b13", "feature");
  const pick = f.cherryPick(b, lane.sha);
  writeCommit(b, "run13-leaf.txt", "rewritten by review\n", "review edit");
  const review = must(["rev-parse", "HEAD"], b);
  const record = rec({ run: "run13", branch: lane.branch, laneTip: lane.sha, into: "feature", portCommit: pick, intoTip: review });

  must(["worktree", "remove", "--force", b], f.repo);
  must(["branch", "-D", "feature"], f.repo);
  const again = f.porting("b13b", "feature");
  writeCommit(again, "recreated.txt", "other\n", "recreated from main");
  must(["merge", "-q", "--squash", "feature"], f.repo);
  must(["commit", "-qm", "land the recreated branch"], f.repo);

  const v = takenVerdict({ record, laneTip: lane.sha, repo: f.toplevel, prefix: PREFIX, gitRunner: f.git });
  equal(v.landed, false, "the new tip does not descend from portCommit, and the recorded tip never landed");
}));

test("row 13c: a reset target appends no refresh", () => withFixture((f) => {
  const b = f.porting("b13c", "feature");
  writeCommit(b, "f1.txt", "1\n", "c1");
  const c1 = must(["rev-parse", "HEAD"], b);
  writeCommit(b, "f2.txt", "2\n", "c2");
  const c2 = must(["rev-parse", "HEAD"], b);
  runDir(f, "run-a");

  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [rec({ intoTip: c2 })] });
  const log = takenLogPath(f.home, f.toplevel);
  const before = readFileSync(log, "utf8");

  must(["reset", "-q", "--hard", c1], b);
  const moved = refreshTaken({ home: f.home, toplevel: f.toplevel, into: "feature", head: c1, git: f.git, fs });

  equal(moved.length, 0, "a head the tip does not descend from refreshes nothing");
  equal(readFileSync(log, "utf8"), before, "the witness is left exactly as it was");
}));

test("row 13d: a lane that moved after the record is ignored", () => withFixture((f) => {
  const lane = f.leaf("run13d", "leaf");
  const b = f.porting("b13d", "feature");
  const pick = f.cherryPick(b, lane.sha);
  writeCommit(b, "run13d-leaf.txt", "rewritten by review\n", "review edit");
  must(["merge", "-q", "--squash", "feature"], f.repo);
  must(["commit", "-qm", "squash feature"], f.repo);
  writeCommit(lane.path, "after.txt", "after\n", "the lane moved on");
  const movedTip = must(["rev-parse", "HEAD"], lane.path);

  const record = rec({ run: "run13d", branch: lane.branch, laneTip: lane.sha, into: "feature", portCommit: pick, intoTip: pick });
  const v = takenVerdict({ record, laneTip: movedTip, repo: f.toplevel, prefix: PREFIX, gitRunner: f.git });
  equal(v.landed, false, "a record only speaks for the tip it was written against");
}));

const TAKEN_URL = new URL("../src/taken.mjs", import.meta.url).href;
const CHILD = `
import { appendTaken } from ${JSON.stringify(TAKEN_URL)};
import * as fs from "node:fs";
const [home, toplevel, run, count] = process.argv.slice(1);
for (let i = 0; i < Number(count); i += 1) {
  appendTaken({ home, toplevel, fs, records: [{
    run, branch: "swarm/" + run + "/leaf-" + i, laneTip: "a".repeat(40), repo: toplevel,
    into: "feature", portCommit: "b".repeat(40), intoTip: "c".repeat(40),
    at: "2026-01-01T00:00:00.000Z",
  }] });
}
`;

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, err }));
  });
}

test("row 14: eight processes appending at once lose no line", async () => {
  const f = portFixture();
  try {
    const runs = Array.from({ length: 8 }, (_, i) => `run-${i}`);
    for (const name of runs) runDir(f, name);
    const results = await Promise.all(runs.map((name) =>
      runChild([f.home, f.toplevel, name, "25"])));
    for (const [i, r] of results.entries()) equal(r.code, 0, `child ${i} failed: ${r.err.slice(0, 300)}`);

    const map = readTaken({ home: f.home, toplevel: f.toplevel, fs });
    equal(map.size, 200, "every line from every process is readable");
    equal(logLines(takenLogPath(f.home, f.toplevel)).length, 200, "no append overwrote another");
  } finally {
    f.cleanup();
  }
});

test("row 14: past 1 MB the log rotates to .1 and readers see both", () => withFixture((f) => {
  for (const name of ["old-run", "new-run"]) runDir(f, name);
  const log = takenLogPath(f.home, f.toplevel);
  mkdirSync(join(f.home, "taken"), { recursive: true });
  const line = JSON.stringify(rec({ run: "old-run", branch: "swarm/old-run/leaf", intoTip: "old" })) + "\n";
  writeFileSync(log, line.repeat(Math.ceil((MAX + 2) / line.length)));
  ok(statSync(log).size > MAX, "precondition: the log is over 1 MB");

  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [rec({ run: "new-run", branch: "swarm/new-run/leaf" })] });

  ok(existsSync(`${log}.1`), "the full log is rotated aside");
  ok(statSync(log).size < 1024, "the live log restarts with the new line");
  const map = readTaken({ home: f.home, toplevel: f.toplevel, fs });
  equal(map.get("old-run\nswarm/old-run/leaf").intoTip, "old", "rotation keeps the older lines readable");
  equal(map.get("new-run\nswarm/new-run/leaf").intoTip, "c".repeat(40));
}));
