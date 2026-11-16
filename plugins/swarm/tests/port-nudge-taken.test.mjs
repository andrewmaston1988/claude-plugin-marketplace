// Taken lanes in the port nudge: a lane ported into a branch that later landed. Row 1
// is the checkout the nudge measures from — a session whose cwd is another tree but
// whose command `cd`s into the porting one. Rows 2, 3, 9 and 15 are the record: one per
// lane the porting HEAD proves, only once git finished the port, refreshed along the
// branch, and bounded so a many-lane run cannot reach the hook's ceiling.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import * as fs from "node:fs";
import { resolve } from "node:path";
import { portingTree, runPortNudge } from "../src/port-nudge.mjs";
import { takenLogPath } from "../src/taken.mjs";
import { portFixture, must, writeCommit } from "./helpers/port-fixture.mjs";

const SESSION = "sess-A";

const withFixture = (fn) => {
  const f = portFixture();
  try { return fn(f); } finally { f.cleanup(); }
};

// A real git fixture is slow on Windows, and recording needs 10 s of the hook budget
// still unspent, so every firing here is given a budget no fixture can exhaust.
const fire = (f, cwd, command, budgetMs = 120_000) => runPortNudge({
  payload: { session_id: SESSION, cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } },
  env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs, budgetMs,
});

const logRecords = (f) => {
  try {
    return fs.readFileSync(takenLogPath(f.home, f.toplevel), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
};

test("row 1: portingTree follows one leading cd, then resolves -C against it", () => {
  // Roots built from a platform-absolute path: a literal "C:/work" is relative on
  // Linux, so the same rows would assert different things on each platform.
  const WORK = resolve("/work");
  const REPO = resolve("/x/my repo");
  const SHA = "a".repeat(40);

  // Quoted (either style) and bare, terminated by && or ;.
  equal(portingTree(`cd "${REPO}" && git cherry-pick ${SHA}`, WORK), REPO);
  equal(portingTree(`cd '${REPO}' && git commit -m x`, WORK), REPO);
  equal(portingTree("cd repo; git merge topic", WORK), resolve(WORK, "repo"));
  equal(portingTree("  cd repo && git merge topic", WORK), resolve(WORK, "repo"));

  // -C is resolved against the cd target, not the payload's cwd.
  equal(portingTree(`cd '${REPO}' && git -C sub commit`, WORK), resolve(REPO, "sub"));
  equal(portingTree("cd repo && git -C sub merge topic", WORK), resolve(WORK, "repo/sub"));

  // Two distinct -C paths leave no single tree: the cd target is the fallback.
  equal(portingTree(`cd "${REPO}" && git -C a commit && git -C b merge x`, WORK), REPO);

  // No leading cd: today's answer, which is the payload's cwd.
  equal(portingTree(`git -C "${REPO}" commit`, WORK), REPO);
  equal(portingTree("git commit -m x", WORK), WORK);

  // A cd mid-chain is not the shell's directory when the command started.
  equal(portingTree(`git status && cd "${REPO}" && git commit -m x`, WORK), WORK);
  equal(portingTree(`echo hi; cd "${REPO}" && git commit`, WORK), WORK);
});

test("row 2: a completed port records each lane its HEAD proves", () => withFixture((f) => {
  const port = f.porting("porting", "feat");
  const picked = f.leaf("run-2", "picked");
  const merged = f.leaf("run-2", "merged");
  f.run("run-2", { launcher: SESSION, leaves: [picked, merged] });
  // One lane only a pick can prove, one whose tip the HEAD contains outright.
  f.cherryPick(port, picked.sha);
  must(["merge", "--no-edit", merged.branch], port);
  const head = must(["rev-parse", "HEAD"], port);

  fire(f, port, `git cherry-pick ${picked.sha}`);

  const recs = logRecords(f);
  equal(recs.length, 2, "one record per lane the porting HEAD proves");
  for (const lane of [picked, merged]) {
    const rec = recs.find((r) => r.branch === lane.branch);
    ok(rec, `a record for ${lane.branch}`);
    equal(rec.run, "run-2");
    equal(rec.laneTip, lane.sha, "the lane tip is the record's subject");
    equal(rec.repo, f.repo);
    equal(rec.into, "feat");
    equal(rec.portCommit, head, "the porting commit is the witness");
    equal(rec.intoTip, head);
    ok(rec.at, "the record is stamped");
  }
}));

test("row 3(a): a conflicted pick records nothing until it is finished", () => withFixture((f) => {
  const lane = f.leaf("run-3a", "lane");
  // The lane's only change is the one the port base rewrites: picking it conflicts, and
  // the resolved commit is what must absorb the whole lane.
  must(["reset", "--hard", "main"], lane.path);
  writeCommit(lane.path, "a.txt", "lane\n", "lane edits a");
  f.run("run-3a", { launcher: SESSION, leaves: [lane] });
  const tip = must(["rev-parse", "HEAD"], lane.path);

  const port = f.porting("porting", "feat");
  writeCommit(port, "a.txt", "port\n", "port edits a");
  const pick = f.git(["cherry-pick", tip], port);
  ok(pick.status !== 0, "precondition: the fixture's pick conflicts");
  ok(fs.existsSync(resolve(port, must(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], port))), "CHERRY_PICK_HEAD is set");

  fire(f, port, `git cherry-pick ${tip}`);
  equal(logRecords(f).length, 0, "an open pick is not a port");

  fs.writeFileSync(resolve(port, "a.txt"), "lane\n");
  must(["add", "a.txt"], port);
  must(["cherry-pick", "--continue", "--no-edit"], port);
  const finished = must(["rev-parse", "HEAD"], port);
  fire(f, port, "git cherry-pick --continue");
  const rec = logRecords(f).find((r) => r.branch === lane.branch);
  ok(rec, "the finished port records");
  equal(rec.portCommit, finished);
}));

test("row 3(b): unmerged index entries record nothing", () => withFixture((f) => {
  const lane = f.leaf("run-3b", "lane");
  must(["reset", "--hard", "main"], lane.path);
  writeCommit(lane.path, "a.txt", "lane\n", "lane edits a");
  f.run("run-3b", { launcher: SESSION, leaves: [lane] });
  const tip = must(["rev-parse", "HEAD"], lane.path);

  const port = f.porting("porting", "feat");
  writeCommit(port, "a.txt", "port\n", "port edits a");
  // `-n` leaves the conflict in the index with no CHERRY_PICK_HEAD behind it.
  ok(f.git(["cherry-pick", "-n", tip], port).status !== 0, "precondition: the pick conflicts");
  ok(!fs.existsSync(resolve(port, must(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], port))), "no CHERRY_PICK_HEAD");
  ok(must(["diff", "--name-only", "--diff-filter=U"], port).length > 0, "unmerged entries exist");

  fire(f, port, `git cherry-pick -n ${tip}`);
  equal(logRecords(f).length, 0, "an unmerged index is not a port");

  fs.writeFileSync(resolve(port, "a.txt"), "lane\n");
  must(["add", "a.txt"], port);
  must(["commit", "-qm", "pick the lane"], port);
  fire(f, port, "git commit -m pick");
  ok(logRecords(f).some((r) => r.branch === lane.branch), "the resolved port records");
}));

test("row 3(c): a port onto the default branch records nothing", () => withFixture((f) => {
  const main = must(["rev-parse", "HEAD"], f.repo);
  must(["update-ref", "refs/remotes/origin/main", main], f.repo);
  must(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], f.repo);

  const leaf = f.leaf("run-3c", "leaf");
  f.run("run-3c", { launcher: SESSION, leaves: [leaf] });
  f.cherryPick(f.repo, leaf.sha);

  fire(f, f.repo, `git cherry-pick ${leaf.sha}`);
  equal(logRecords(f).length, 0, "the default branch needs no record");
}));

test("row 3(d): a swarm branch or a detached HEAD records nothing", () => withFixture((f) => {
  const leaf = f.leaf("run-3d", "leaf");
  f.run("run-3d", { launcher: SESSION, leaves: [leaf] });
  fire(f, leaf.path, "git commit -m x");
  equal(logRecords(f).length, 0, "a leaf's own swarm branch is never a porting tree");

  const port = f.porting("porting", "feat");
  f.cherryPick(port, leaf.sha);
  must(["checkout", "--detach"], port);
  fire(f, port, "git commit -m x");
  equal(logRecords(f).length, 0, "a detached HEAD names no branch to port into");
}));

test("row 3(e,f): no record for a lane the porting HEAD does not prove", () => withFixture((f) => {
  const leaf = f.leaf("run-3ef", "leaf");
  f.run("run-3ef", { launcher: SESSION, leaves: [leaf] });

  const port = f.porting("porting", "feat");
  fire(f, port, "git commit -m x");
  equal(logRecords(f).length, 0, "no pick, no record");

  // An unrelated branch holds the lane: the ref-reachability shortcut is not the gate.
  must(["branch", "elsewhere", leaf.sha], f.repo);
  fire(f, port, "git commit -m x");
  equal(logRecords(f).length, 0, "another ref's copy is not this HEAD's port");
}));

test("row 9: a later commit on the recorded branch moves intoTip; another branch does not", () => withFixture((f) => {
  const port = f.porting("porting", "feat");
  const leaf = f.leaf("run-9", "leaf");
  f.run("run-9", { launcher: SESSION, leaves: [leaf] });
  const picked = f.cherryPick(port, leaf.sha);
  fire(f, port, `git cherry-pick ${leaf.sha}`);
  const first = logRecords(f);
  equal(first.length, 1, "the port recorded once");
  equal(first[0].intoTip, picked);

  writeCommit(port, "review.txt", "review\n", "review the port");
  const moved = must(["rev-parse", "HEAD"], port);
  fire(f, port, "git commit -m review");
  const after = logRecords(f);
  equal(after.length, 2, "one refresh line, appended");
  equal(after.at(-1).intoTip, moved, "the witness moved with the branch");
  equal(after.at(-1).portCommit, picked, "the porting commit never moves");

  const other = f.porting("other", "feat2");
  writeCommit(other, "other.txt", "other\n", "other work");
  fire(f, other, "git commit -m other");
  equal(logRecords(f).length, 2, "a commit on another branch refreshes nothing");
  equal(logRecords(f).at(-1).intoTip, moved, "the record still points at its own branch");
}));

test("row 15: one firing records at most 12 lanes and none with under 10 s left", () => withFixture((f) => {
  const port = f.porting("porting", "feat");
  const leaves = Array.from({ length: 20 }, (_, i) => f.leaf("run-15", `leaf${i}`));
  for (const lane of leaves) f.cherryPick(port, lane.sha);
  f.run("run-15", { launcher: SESSION, leaves });

  fire(f, port, "git commit -m x", 120_000);
  equal(logRecords(f).length, 12, "the cap bounds one firing");
}));

test("row 15: with under 10 s of budget left nothing is recorded and the turn is unaffected", () => withFixture((f) => {
  const port = f.porting("porting", "feat");
  const leaf = f.leaf("run-15b", "leaf");
  f.run("run-15b", { launcher: SESSION, leaves: [leaf] });
  f.cherryPick(port, leaf.sha);

  // The clock is real until the measure's own budget checks are done, then it jumps to
  // the last seconds of the budget: the run is still reported, recording is skipped.
  const realNow = Date.now;
  const start = 1_000_000;
  let calls = 0;
  Date.now = () => (++calls <= 3 ? start : start + 115_000);
  let out;
  try { out = fire(f, port, "git commit -m x"); } finally { Date.now = realNow; }
  ok(out !== "", "the run is still reported");
  equal(logRecords(f).length, 0, "no record is taken on the last seconds of the budget");
}));
