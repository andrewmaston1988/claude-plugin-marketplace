// The taken log and the checks it composes (test-plan rows 4-8, 13 and 14): a port is
// recorded only once git finished it, the proof is append-only, and landing is decided
// against the default branch alone.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, statSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { takenLogPath, appendTaken, readTaken, refreshTaken, takenKey, takenVerdict } from "../src/taken.mjs";
import { portInProgress } from "../src/port-complete.mjs";
import { landedOnDefault } from "../src/landed.mjs";
import { portFixture, must, writeCommit, git, publishDefault } from "./helpers/port-fixture.mjs";
import { initRepo } from "./helpers/worktree-fixtures.mjs";

const PREFIX = "swarm/";
const MAX = 1024 * 1024;
const OPTS = { prefix: PREFIX, gitRunner: git };

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

const key = (run, branch, repo = "/repo") => takenKey({ run, repo, branch });

function withFixture(fn) {
  const f = portFixture();
  try { return fn(f); } finally { f.cleanup(); }
}

function withRepo(fn) {
  const repo = initRepo();
  try { return fn(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
}

const runDir = (f, name) => mkdirSync(join(f.runsRoot, name), { recursive: true });
const logLines = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);

// feat and main rewrote the same line, so a pick, a merge, a revert and a rebase all
// stop mid-flight in the porting worktree.
function diverged() {
  const f = portFixture();
  const port = f.porting();
  writeCommit(port, "a.txt", "feat\n", "feat");
  writeCommit(f.repo, "a.txt", "main\n", "mainchange");
  writeCommit(f.repo, "b.txt", "x\n", "second");
  return {
    f,
    port,
    mainChange: must(["rev-parse", "main~1"], f.repo),
    second: must(["rev-parse", "main"], f.repo),
  };
}

const marker = (tree, name) => resolve(tree, must(["rev-parse", "--git-path", name], tree));

// The command must stop, and the state it leaves must read in progress. Resolving the
// index proves git's own marker still speaks, not the unmerged entry every conflict
// leaves behind — so each marker name is pinned on its own.
function stopped(f, tree, args, markerName) {
  equal(git(args, tree).status, 1, `${args.join(" ")} must stop on a conflict`);
  ok(existsSync(marker(tree, markerName)), `${markerName} after ${args.join(" ")}`);
  equal(portInProgress(tree, f.git), true, `${args.join(" ")}: unmerged`);
  must(["checkout", "--ours", "--", "a.txt"], tree);
  must(["add", "--", "a.txt"], tree);
  equal(must(["diff", "--name-only", "--diff-filter=U"], tree), "", `${args.join(" ")}: index resolved`);
  equal(portInProgress(tree, f.git), true, `${args.join(" ")}: the marker alone`);
}

test("row 4: every in-progress state reads in progress, and each abort clears it", () => {
  const { f, port, mainChange, second } = diverged();
  try {
    equal(portInProgress(port, f.git), false, "a clean porting checkout");

    stopped(f, port, ["merge", "main"], "MERGE_HEAD");
    must(["merge", "--abort"], port);
    equal(portInProgress(port, f.git), false, "a merge abort clears it");

    stopped(f, port, ["cherry-pick", mainChange], "CHERRY_PICK_HEAD");
    must(["cherry-pick", "--abort"], port);
    equal(portInProgress(port, f.git), false, "a pick abort clears it");

    stopped(f, port, ["revert", "--no-edit", mainChange], "REVERT_HEAD");
    must(["revert", "--abort"], port);

    stopped(f, port, ["rebase", "main"], "rebase-merge");
    must(["rebase", "--abort"], port);

    stopped(f, port, ["rebase", "--apply", "main"], "rebase-apply");
    must(["rebase", "--abort"], port);
    equal(portInProgress(port, f.git), false, "a rebase abort clears it");

    // A multi-commit pick queues a sequencer. `--quit` then drops the markers, so the
    // last check must catch an index left unmerged with nothing else to name it.
    stopped(f, port, ["cherry-pick", mainChange, second], "sequencer");
    must(["cherry-pick", "--quit"], port);
    equal(portInProgress(port, f.git), false, "a quit over a resolved index leaves nothing");
    must(["reset", "--hard", "-q"], port);

    equal(git(["cherry-pick", mainChange], port).status, 1, "a single pick stops on the conflict");
    must(["cherry-pick", "--quit"], port);
    ok(!existsSync(marker(port, "CHERRY_PICK_HEAD")), "--quit drops CHERRY_PICK_HEAD");
    ok(!existsSync(marker(port, "sequencer")), "--quit drops the sequencer");
    ok(must(["diff", "--name-only", "--diff-filter=U"], port) !== "", "the index is still unmerged");
    equal(portInProgress(port, f.git), true, "an unmerged index alone is in progress");
  } finally { f.cleanup(); }
});

test("row 4: markers resolve through git's own path, not `<tree>/.git`", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    // A linked worktree's `.git` is a file, so only `--git-path` finds its markers.
    const resolved = marker(port, "CHERRY_PICK_HEAD");
    ok(!resolved.startsWith(join(port, ".git") + sep), `a linked worktree keeps markers outside its tree: ${resolved}`);
    ok(resolved.startsWith(resolve(f.repo, ".git") + sep), resolved);

    equal(portInProgress(port, f.git), false, "clean before the marker");
    writeFileSync(resolved, `${must(["rev-parse", "HEAD"], port)}\n`);
    equal(portInProgress(port, f.git), true, "the admin-dir marker is seen");
    rmSync(resolved);
    equal(portInProgress(port, f.git), false, "and only that marker counts");

    // The main worktree reports `.git/<name>` relative to the tree.
    const relative = must(["rev-parse", "--git-path", "MERGE_HEAD"], f.repo);
    ok(!/^([A-Za-z]:[\\/]|[\\/])/.test(relative), `the main worktree's path is relative: ${relative}`);
    const abs = resolve(f.repo, relative);
    writeFileSync(abs, `${must(["rev-parse", "HEAD"], f.repo)}\n`);
    equal(portInProgress(f.repo, f.git), true, "a relative marker resolves against the tree");
    rmSync(abs);
    equal(portInProgress(f.repo, f.git), false);
  } finally { f.cleanup(); }
});

test("row 4: a git that cannot answer reads in progress", () => {
  const f = portFixture();
  try {
    const failing = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    equal(portInProgress(f.repo, failing), true, "a git failure records nothing");

    const throwing = () => { throw new Error("spawn failed"); };
    equal(portInProgress(f.repo, throwing), true, "a thrown git call records nothing");

    // Marker probes answer; the unmerged probe fails. Still no proof of a finished port.
    const mixed = (args) => (args.includes("--diff-filter=U")
      ? { status: 128, stdout: "", stderr: "fatal" }
      : { status: 0, stdout: ".git/CHERRY_PICK_HEAD", stderr: "" });
    equal(portInProgress(f.repo, mixed), true, "a failed unmerged probe is no proof");

    // A short answer names some markers and not the rest.
    const short = (args) => ({ status: 0, stdout: args.includes("--diff-filter=U") ? "" : ".git/CHERRY_PICK_HEAD", stderr: "" });
    equal(portInProgress(f.repo, short), true, "an answer naming one marker of six is no proof");

    throws(() => portInProgress(f.repo), TypeError, "the git runner is required");
  } finally { f.cleanup(); }
});

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
  equal(map.get(key("run-a", "swarm/run-a/leaf")).intoTip, "new", "the live log wins over the rotation");
  equal(map.get(key("run-b", "swarm/run-b/leaf")).intoTip, "only-b", "a line only the rotation holds is still read");
  equal(map.has(key("run-gone", "swarm/run-gone/leaf")), false, "a run whose dir is gone is history, not a record");

  const before = readFileSync(log, "utf8");
  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [rec({ run: "run-b", branch: "swarm/run-b/other" })] });
  ok(readFileSync(log, "utf8").startsWith(before), "an append never rewrites an earlier line");
}));

test("row 5: the same lane name in two repos is two records", () => withFixture((f) => {
  runDir(f, "run-a");
  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [
    rec({ repo: join(f.home, "one") }),
    rec({ repo: join(f.home, "two") }),
  ] });

  const map = readTaken({ home: f.home, toplevel: f.toplevel, fs });
  equal(map.size, 2, "a multi-repo run's lanes never overwrite each other");
  equal(map.get(key("run-a", "swarm/run-a/leaf", join(f.home, "two"))).repo, join(f.home, "two"));
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
  const a = map.get(key("run-a", "swarm/run-a/leaf"));
  equal(a.intoTip, c2, "a descendant head moves intoTip");
  equal(a.portCommit, "port", "portCommit is the original witness and never changes");
  equal(map.get(key("run-b", "swarm/run-b/leaf")).intoTip, c1, "another branch's record is untouched");
  equal(map.get(key("run-c", "swarm/run-c/leaf")).intoTip, c3, "a head below intoTip is a reset, not a refresh");
  equal(logLines(log).length, lines + 1, "exactly one refresh line is appended");

  refreshTaken({ home: f.home, toplevel: f.toplevel, into: "feature", head: c2, git: f.git, fs });
  equal(logLines(log).length, lines + 1, "an unchanged tip appends nothing");
}));

test("row 6: a spent budget refreshes nothing", () => withFixture((f) => {
  const b = f.porting("b6d", "feature");
  writeCommit(b, "f1.txt", "1\n", "c1");
  const c1 = must(["rev-parse", "HEAD"], b);
  writeCommit(b, "f2.txt", "2\n", "c2");
  const c2 = must(["rev-parse", "HEAD"], b);
  runDir(f, "run-a");
  appendTaken({ home: f.home, toplevel: f.toplevel, fs, records: [rec({ intoTip: c1 })] });
  const log = takenLogPath(f.home, f.toplevel);
  const before = readFileSync(log, "utf8");

  const moved = refreshTaken({ home: f.home, toplevel: f.toplevel, into: "feature", head: c2, git: f.git, fs, deadline: 0 });

  equal(moved.length, 0, "the hook's budget is spent before the first git call");
  equal(readFileSync(log, "utf8"), before, "no refresh line is appended");
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
  publishDefault(f.repo);
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

test("row 8: landedOnDefault is true for a commit the default branch contains", () => withRepo((repo) => {
  writeCommit(repo, "a.txt", "main work\n", "main work");
  const tip = must(["rev-parse", "HEAD"], repo);
  publishDefault(repo);

  equal(landedOnDefault(tip, repo, OPTS), true);
}));

// The default branch is named by a remote HEAD alone. The checkout during a port IS the
// port branch, so reading it as the default measures the branch against itself and frees
// a lane whose work never landed — on an irreversible delete.
test("row 8: with no remote there is no default branch, and a taken lane stays unlanded", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "feat"], repo);
  writeCommit(repo, "feat.txt", "feat work\n", "feat work");
  const tip = must(["rev-parse", "HEAD"], repo);
  const record = rec({ repo, into: "feat", portCommit: must(["rev-parse", "HEAD~1"], repo), intoTip: tip });

  equal(landedOnDefault(tip, repo, OPTS), false, "the checkout is not a default branch");
  const v = takenVerdict({ record, laneTip: record.laneTip, repo, prefix: PREFIX, gitRunner: git });
  equal(v.landed, false, "a lane taken into the checkout's own branch is not landed");
}));

test("row 8: the remote naming the default branch need not be origin", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "feat"], repo);
  writeCommit(repo, "feat.txt", "feat work\n", "feat work");
  must(["checkout", "-q", "main"], repo);
  writeCommit(repo, "landed.txt", "landed work\n", "landed work");
  const landed = must(["rev-parse", "HEAD"], repo);
  publishDefault(repo, { remote: "upstream" });
  must(["checkout", "-q", "feat"], repo);
  equal(git(["merge-base", "--is-ancestor", landed, "HEAD"], repo).status, 1, "HEAD is on the port branch");

  equal(landedOnDefault(landed, repo, OPTS), true, "upstream's HEAD names the default branch");
}));

test("row 8: landedOnDefault is true for a commit the default branch absorbs", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "swarm/leaf", "main"], repo);
  writeCommit(repo, "a.txt", "leaf a\n", "leaf a");
  writeCommit(repo, "b.txt", "leaf b\n", "leaf b");
  const laneTip = must(["rev-parse", "HEAD"], repo);
  must(["checkout", "-q", "main"], repo);
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash leaf"], repo);
  publishDefault(repo);
  ok(must(["rev-parse", "HEAD"], repo) !== laneTip, "precondition: the squash is a new commit");

  equal(landedOnDefault(laneTip, repo, OPTS), true);
}));

test("row 8: a commit only a non-default local ref holds is not landed", () => withRepo((repo) => {
  must(["checkout", "-q", "-b", "feat", "main"], repo);
  writeCommit(repo, "feat.txt", "feat work\n", "feat work");
  const featTip = must(["rev-parse", "HEAD"], repo);
  must(["checkout", "-q", "main"], repo);

  equal(landedOnDefault(featTip, repo, OPTS), false);
}));

test("row 13(a): a branch pushed but never merged is not landed", () => withRepo((repo) => {
  publishDefault(repo);
  must(["checkout", "-q", "-b", "feat", "main"], repo);
  writeCommit(repo, "feat.txt", "feat work\n", "feat work");
  const featTip = must(["rev-parse", "HEAD"], repo);
  // The ref a push leaves once the branch is deleted locally.
  must(["update-ref", "refs/remotes/origin/feat", featTip], repo);
  must(["checkout", "-q", "main"], repo);
  must(["branch", "-q", "-D", "feat"], repo);
  ok(must(["for-each-ref", "--contains", featTip, "--format=%(refname)"], repo).includes("refs/remotes/origin/feat"),
    "precondition: a remote-tracking ref is the only thing holding the commit");

  equal(landedOnDefault(featTip, repo, OPTS), false);
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
  equal(map.get(key("old-run", "swarm/old-run/leaf")).intoTip, "old", "rotation keeps the older lines readable");
  equal(map.get(key("new-run", "swarm/new-run/leaf")).intoTip, "c".repeat(40));
}));
