import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareIsolation, collect, integrate } from "../src/worktree.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-wt-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  return repo;
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

function commitAll(cwd, msg) {
  spawnSync("git", ["add", "."], { cwd, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", msg], { cwd, windowsHide: true });
}

// git holds the worktree dir open; remove it before rmSync'ing the repo.
function dropWorktree(repo, path) {
  spawnSync("git", ["worktree", "remove", "--force", path], { cwd: repo, windowsHide: true });
}

test("prepareIsolation creates a worktree on the prefixed branch at repo HEAD", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "impl", originalCwd: repo, cwd: repo };
    const wt = prepareIsolation(task, CFG, resultsDir);
    equal(wt.branch, "swarm/impl");
    equal(wt.path, join(resultsDir, "wt-impl"));
    ok(existsSync(join(wt.path, "a.txt")));
    equal(git(["branch", "--show-current"], wt.path), "swarm/impl");
    equal(git(["rev-parse", "HEAD"], wt.path), git(["rev-parse", "HEAD"], repo));
  } finally {
    cleanup(resultsDir, repo);
  }
});

test("branch prefix comes from config, never hardcoded", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const wt = prepareIsolation({ id: "x", originalCwd: repo }, { worktreeBranchPrefix: "custom/" }, resultsDir);
    equal(wt.branch, "custom/x");
  } finally {
    cleanup(resultsDir, repo);
  }
});

test("prepareIsolation re-enters a kept worktree in place — a resend keeps the partial diff, no 0s-fail", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "impl", originalCwd: repo, cwd: repo };
    const wt = prepareIsolation(task, CFG, resultsDir);
    // leaf did partial work then timed out — the worktree is kept, dirty
    writeFileSync(join(wt.path, "partial.txt"), "half-done work\n");

    // a resend re-enters the SAME worktree rather than throwing "already exists"
    const again = prepareIsolation(task, CFG, resultsDir);
    equal(again.path, wt.path);
    equal(again.reused, true, "must signal it re-entered an existing worktree");
    ok(existsSync(join(again.path, "partial.txt")), "partial diff must survive the resend");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(resultsDir, "wt-impl")], { cwd: repo, windowsHide: true });
    cleanup(resultsDir, repo);
  }
});

test("prepareIsolation with { reset } scrubs a kept worktree clean — the --force redo path", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "impl", originalCwd: repo, cwd: repo };
    const wt = prepareIsolation(task, CFG, resultsDir);
    writeFileSync(join(wt.path, "partial.txt"), "half-done work\n");
    writeFileSync(join(wt.path, "a.txt"), "tampered\n");

    const forced = prepareIsolation(task, CFG, resultsDir, { reset: true });
    equal(forced.path, wt.path);
    equal(forced.reused, true);
    ok(!existsSync(join(forced.path, "partial.txt")), "untracked partial work is cleaned");
    equal(git(["status", "--porcelain"], forced.path), "", "tree is clean after reset");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(resultsDir, "wt-impl")], { cwd: repo, windowsHide: true });
    cleanup(resultsDir, repo);
  }
});

test("prepareIsolation on a fresh path still creates and reports reused:false", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const wt = prepareIsolation({ id: "fresh", originalCwd: repo }, CFG, resultsDir);
    equal(wt.reused, false);
    ok(existsSync(join(wt.path, "a.txt")));
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(resultsDir, "wt-fresh")], { cwd: repo, windowsHide: true });
    cleanup(resultsDir, repo);
  }
});

test("two tasks sharing a worktree name land in one tree on one branch", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const p1 = { id: "p1", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const p2 = { id: "p2", worktreeName: "feat", originalCwd: repo, cwd: repo };

    const wt1 = prepareIsolation(p1, CFG, resultsDir);
    equal(wt1.branch, "swarm/feat", "branch comes from the name, not the task id");
    equal(wt1.name, "feat");
    ok(wt1.path.endsWith("wt-feat"), `expected wt-feat, got ${wt1.path}`);

    writeFileSync(join(wt1.path, "phase1.txt"), "phase 1 work\n");
    commitAll(wt1.path, "phase 1");

    const wt2 = prepareIsolation(p2, CFG, resultsDir);
    equal(wt2.path, wt1.path, "second task re-enters the same tree");
    equal(wt2.branch, wt1.branch);
    ok(wt2.reused, "second task reuses rather than creates");
    ok(existsSync(join(wt2.path, "phase1.txt")), "p2 must see p1's committed work");
  } finally {
    dropWorktree(repo, join(resultsDir, "wt-feat"));
    cleanup(resultsDir, repo);
  }
});

test("a follower's head is the tree's HEAD, so its diffstat spans only its own work", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const p1 = { id: "p1", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const wt1 = prepareIsolation(p1, CFG, resultsDir);
    writeFileSync(join(wt1.path, "phase1.txt"), "work\n");
    commitAll(wt1.path, "phase 1");
    const phase1Head = git(["rev-parse", "HEAD"], wt1.path);

    const rev = { id: "rev", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const wtR = prepareIsolation(rev, CFG, resultsDir);
    equal(wtR.path, wt1.path);
    equal(wtR.head, phase1Head, "a follower starts from what its predecessor left, not repo HEAD");

    // The reviewer touched nothing, so relative to ITS start the diff is empty —
    // but it is a follower, so the tree survives with its predecessor's commit.
    const c = collect(rev, CFG, wtR, { isChainFollower: true });
    equal(c.diffstat, "", "an unchanged follower reports no work of its own");
    equal(c.kept, true, "a follower's branch carries its predecessors' commits — never destroy it");
    ok(existsSync(join(wt1.path, "phase1.txt")), "p1's committed work must survive the collect");
  } finally {
    dropWorktree(repo, join(resultsDir, "wt-feat"));
    cleanup(resultsDir, repo);
  }
});

test("--force on a follower resets to repo HEAD, not the tree's", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const p1 = { id: "p1", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const wt1 = prepareIsolation(p1, CFG, resultsDir);
    writeFileSync(join(wt1.path, "phase1.txt"), "work\n");
    commitAll(wt1.path, "phase 1");

    const p2 = { id: "p2", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const forced = prepareIsolation(p2, CFG, resultsDir, { reset: true });
    equal(forced.head, git(["rev-parse", "HEAD"], repo), "a reset restarts the group from repo HEAD");
    ok(!existsSync(join(forced.path, "phase1.txt")), "reset scrubs the whole group's work");
  } finally {
    dropWorktree(repo, join(resultsDir, "wt-feat"));
    cleanup(resultsDir, repo);
  }
});

test("a task with no worktreeName keeps its per-task tree (regression)", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const wt = prepareIsolation({ id: "impl", originalCwd: repo, cwd: repo }, CFG, resultsDir);
    equal(wt.branch, "swarm/impl");
    equal(wt.name, "impl");
    ok(wt.path.endsWith("wt-impl"));
  } finally {
    dropWorktree(repo, join(resultsDir, "wt-impl"));
    cleanup(resultsDir, repo);
  }
});

test("collect never destroys a reused tree — a failed follower would take the chain's commits", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const p1 = { id: "p1", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const wt1 = prepareIsolation(p1, CFG, resultsDir);
    writeFileSync(join(wt1.path, "phase1.txt"), "phase 1 work\n");
    commitAll(wt1.path, "phase 1");

    // p2 is the final link and fails without touching the tree: relative to its
    // own start HEAD nothing changed, which is the destroy condition.
    const p2 = { id: "p2", worktreeName: "feat", originalCwd: repo, cwd: repo };
    const wt2 = prepareIsolation(p2, CFG, resultsDir);
    const c = collect(p2, CFG, wt2, { isChainFollower: true });

    equal(c.kept, true, "the shared branch must survive");
    ok(existsSync(join(wt2.path, "phase1.txt")), "p1's committed work must still be there");
    ok(git(["branch", "--list", "swarm/feat"], repo) !== "", "the branch must not be deleted");
  } finally {
    dropWorktree(repo, join(resultsDir, "wt-feat"));
    cleanup(resultsDir, repo);
  }
});

// A resumed SOLO task (not a chain member) also gets wt.reused: true on
// re-entry, but has no predecessor commits to protect — an unchanged resend
// must still be swept, same as before chains existed.
test("collect sweeps an unchanged worktree on solo resend, even though it was reused", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "solo", originalCwd: repo };
    const wt1 = prepareIsolation(task, CFG, resultsDir);
    // First attempt "fails" without touching the tree — nothing to collect yet.
    // Re-enter (simulating a resend): reused: true, but isChainFollower defaults
    // to false because collect() is called without it (solo task, group size 1).
    const wt2 = prepareIsolation(task, CFG, resultsDir);
    ok(wt2.reused, "the resend must re-enter the same tree");
    const c = collect(task, CFG, wt2);

    equal(c.kept, false, "an unchanged solo resend must still be swept");
    ok(!existsSync(wt2.path), "worktree dir should be removed");
    const branches = git(["branch", "--list", "swarm/solo"], repo);
    equal(branches, "", "branch should be deleted");
  } finally {
    cleanup(resultsDir, repo);
  }
});

test("collect removes an unchanged worktree and deletes its branch", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "noop", originalCwd: repo };
    const wt = prepareIsolation(task, CFG, resultsDir);
    const c = collect(task, CFG, wt);
    equal(c.kept, false);
    equal(c.branch, "swarm/noop");
    ok(!existsSync(wt.path), "worktree dir should be removed");
    const branches = git(["branch", "--list", "swarm/noop"], repo);
    equal(branches, "", "branch should be deleted");
  } finally {
    cleanup(resultsDir, repo);
  }
});

test("collect keeps a changed worktree with porcelain + diffstat (uncommitted)", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "edit", originalCwd: repo };
    const wt = prepareIsolation(task, CFG, resultsDir);
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    writeFileSync(join(wt.path, "new.txt"), "brand new\n");
    const c = collect(task, CFG, wt);
    equal(c.kept, true);
    equal(c.branch, "swarm/edit");
    ok(existsSync(wt.path), "changed worktree must be kept");
    ok(c.porcelain.includes("a.txt"), c.porcelain);
    ok(c.porcelain.includes("new.txt"), c.porcelain);
    ok(c.diffstat.includes("a.txt"), c.diffstat);
  } finally {
    // remove worktree before repo so git doesn't hold locks
    spawnSync("git", ["worktree", "remove", "--force", join(resultsDir, "wt-edit")], { cwd: repo, windowsHide: true });
    cleanup(resultsDir, repo);
  }
});

test("collect keeps a worktree whose changes were committed", () => {
  const repo = initRepo();
  const resultsDir = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const task = { id: "commit", originalCwd: repo };
    const wt = prepareIsolation(task, CFG, resultsDir);
    writeFileSync(join(wt.path, "b.txt"), "committed change\n");
    spawnSync("git", ["add", "."], { cwd: wt.path, windowsHide: true });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "leaf work"], { cwd: wt.path, windowsHide: true });
    const c = collect(task, CFG, wt);
    equal(c.kept, true);
    ok(c.diffstat.includes("b.txt"), c.diffstat);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(resultsDir, "wt-commit")], { cwd: repo, windowsHide: true });
    cleanup(resultsDir, repo);
  }
});

test("scheduler resume: a failed isolated leaf re-enters its kept worktree AND resumes its session", async () => {
  const repo = initRepo();
  const dir = mkdtempSync(join(tmpdir(), "swarm-wt-resume-"));
  const SID = "sess-abc123";
  const streamOut = (text, sid, isErr) => [
    JSON.stringify({ type: "system", subtype: "init", session_id: sid }),
    JSON.stringify({ type: "result", subtype: isErr ? "error" : "success", is_error: !!isErr, result: text }),
  ].join("\n") + "\n";
  try {
    const spawn = fakeSpawnFactory((call, i) => {
      writeFileSync(join(call.opts.cwd, "partial.txt"), `work ${i}\n`); // change the tree so it is kept
      return i === 0
        ? { output: streamOut("boom", SID, true), exit: 1 }    // first attempt fails, but a session exists
        : { output: streamOut("done", SID, false), exit: 0 };  // the resume succeeds
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [{
        id: "impl", prompt: "do it", model: "haiku", allowedTools: "Read,Edit,Bash",
        cwd: repo, originalCwd: repo, scratchRedirect: false, isolation: "worktree", timeoutMs: 5000, after: [],
      }],
    };
    const first = await runPlan(p, CFG, io);
    equal(first.summary.tasks[0].state, "failed");
    equal(first.worktreesKept.length, 1, "the failed leaf's changed worktree is kept for salvage");

    // resume (NOT force): re-enter the kept worktree + resume the stored session
    const second = await runPlan(p, CFG, io);
    equal(second.summary.tasks[0].state, "ok", "resume re-executes instead of 0s-failing");
    const resumeArgv = (spawn.calls.at(-1).args ?? spawn.calls.at(-1).argv);
    ok(resumeArgv.includes("--resume") && resumeArgv.includes(SID),
      "the resume dispatch must carry --resume <sessionId>: " + resumeArgv.join(" "));
    const log = readFileSync(join(p.resultsDir, "run.log"), "utf8");
    ok(/"event":"worktree-resume"/.test(log), "the worktree re-entry is logged loudly");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "run", "wt-impl")], { cwd: repo, windowsHide: true });
    cleanup(dir, repo);
  }
});

test("scheduler integration: isolation task runs IN the worktree; summary lists kept branch", async () => {
  const repo = initRepo();
  const dir = mkdtempSync(join(tmpdir(), "swarm-wt-e2e-"));
  try {
    const spawn = fakeSpawnFactory((call) => {
      // leaf "writes" into its cwd — which must be the worktree, not the repo
      writeFileSync(join(call.opts.cwd, "made-by-leaf.txt"), "output\n");
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo,
      resultsDir: join(dir, "run"),
      concurrency: 2,
      goal: "",
      tasks: [{
        id: "impl", prompt: "implement", model: "haiku", allowedTools: "Read,Edit,Bash",
        cwd: repo, originalCwd: repo, scratchRedirect: false, isolation: "worktree",
        timeoutMs: 5000, after: [],
      }],
    };
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls[0].opts.cwd, join(p.resultsDir, "wt-impl"));
    equal(r.summary.tasks[0].state, "ok");
    equal(r.worktreesKept.length, 1);
    equal(r.worktreesKept[0].branch, "swarm/impl");
    equal(r.summary.worktreesKept[0].name, "impl");
    ok(!existsSync(join(repo, "made-by-leaf.txt")), "user's real tree untouched");
    const res = JSON.parse(spawnSync("node", ["-e",
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(join(p.resultsDir, "results", "impl.json"))},"utf8"))`],
      { encoding: "utf8", windowsHide: true }).stdout);
    equal(res.worktree.kept, true);
    ok(res.worktree.porcelain.includes("made-by-leaf.txt"));
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(dir, "run", "wt-impl")], { cwd: repo, windowsHide: true });
    cleanup(dir, repo);
  }
});

test("collect never deletes a branch carrying commits it did not create", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    // Phase 1 lands real work on the shared branch.
    const p1 = prepareIsolation({ id: "p1", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    writeFileSync(join(p1.path, "phase1.txt"), "phase 1 work\n");
    commitAll(p1.path, "phase 1");
    const phase1Tip = git(["rev-parse", "HEAD"], p1.path);

    // A later leaf re-enters the same tree and changes NOTHING of its own — a
    // review leaf, a no-op, a leaf that found nothing to do. It is the sole
    // member of its group in this plan, so isChainFollower is false.
    const p2 = prepareIsolation({ id: "p2", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    ok(p2.reused, "re-entered the existing tree");
    const out = collect({ id: "p2" }, CFG, p2, { isChainFollower: false });

    const branches = git(["branch", "--list", "swarm/feat"], repo);
    ok(branches.includes("swarm/feat"),
      "branch carrying phase 1's commits must survive a no-op successor");
    equal(git(["rev-parse", "swarm/feat"], repo), phase1Tip, "and still point at phase 1's work");
    ok(out.kept, "a tree whose branch carries uncollected work is kept");
  } finally { cleanup(repo, results); }
});

test("prepareIsolation refuses to force-reset a branch carrying commits", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    // A prior run left commits on swarm/feat, then its worktree was removed by
    // hand (or pruned) while the branch survived.
    const first = prepareIsolation({ id: "p1", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    writeFileSync(join(first.path, "work.txt"), "real work\n");
    commitAll(first.path, "phase 1");
    const tip = git(["rev-parse", "swarm/feat"], repo);
    spawnSync("git", ["worktree", "remove", "--force", first.path], { cwd: repo, windowsHide: true });

    // A fresh run in a DIFFERENT resultsDir resolves a new path, so the -B
    // fallback would otherwise reset swarm/feat to repo HEAD, discarding it.
    const other = mkdtempSync(join(tmpdir(), "swarm-wt-res2-"));
    try {
      let threw = null;
      try {
        prepareIsolation({ id: "p2", originalCwd: repo, worktreeName: "feat" }, CFG, other);
      } catch (e) { threw = e; }
      ok(threw, "must refuse rather than silently reset a branch with commits");
      ok(/carries \d+ unlanded commit/i.test(threw.message), `message should name the loss: ${threw?.message}`);
      equal(git(["rev-parse", "swarm/feat"], repo), tip, "branch still points at phase 1");
    } finally { cleanup(other); }
  } finally { cleanup(repo, results); }
});

test("prepareIsolation still force-resets an EMPTY stale branch after HEAD moves sideways", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    // Stale branch carrying nothing, tree removed — the legitimate -B case.
    const first = prepareIsolation({ id: "p1", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    spawnSync("git", ["worktree", "remove", "--force", first.path], { cwd: repo, windowsHide: true });

    // Repo HEAD moves SIDEWAYS (a different branch), so the stale branch is not
    // an ancestor of HEAD — an ancestry-based guard would wrongly refuse here.
    spawnSync("git", ["checkout", "-q", "-b", "other"], { cwd: repo, windowsHide: true });
    writeFileSync(join(repo, "b.txt"), "elsewhere\n");
    commitAll(repo, "sideways");

    const other = mkdtempSync(join(tmpdir(), "swarm-wt-res2-"));
    try {
      const wt = prepareIsolation({ id: "p2", originalCwd: repo, worktreeName: "feat" }, CFG, other);
      ok(existsSync(wt.path), "an empty stale branch is still safe to reuse");
    } finally { cleanup(other); }
  } finally { cleanup(repo, results); }
});

test("isolation.branch names the branch independently of the tree", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    const wt = prepareIsolation(
      { id: "p3", originalCwd: repo, worktreeName: "p3", branchName: "swarm/eco-p3branch" },
      CFG, results);
    equal(wt.branch, "swarm/eco-p3branch", "explicit branch wins over the derived name");
    ok(wt.path.endsWith("wt-p3"), "the tree is still keyed by the worktree name");
    ok(git(["branch", "--list", "swarm/eco-p3branch"], repo).includes("swarm/eco-p3branch"));
  } finally { cleanup(repo, results); }
});

test("isolation.from bases a private tree on a dependency's branch tip", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
  try {
    // The upstream leaf commits a helper on its own branch.
    const up = prepareIsolation({ id: "helper", originalCwd: repo, worktreeName: "helper" }, CFG, results);
    writeFileSync(join(up.path, "helper.txt"), "the helper\n");
    commitAll(up.path, "add helper");
    const helperTip = git(["rev-parse", "HEAD"], up.path);

    // A downstream leaf bases on that branch instead of repo HEAD.
    const down = prepareIsolation(
      { id: "migrate-x", originalCwd: repo, worktreeName: "migrate-x", baseRef: "swarm/helper" },
      CFG, results);
    ok(existsSync(join(down.path, "helper.txt")), "the dependency's committed work is present");
    equal(down.head, helperTip, "wt.head is the base ref, so an empty leaf still reads as unchanged");
  } finally { cleanup(repo, results); }
});

test("scheduler integration: a from-based leaf starts from its dependency's commit", async () => {
  const repo = initRepo();
  const dir = mkdtempSync(join(tmpdir(), "swarm-wt-from-"));
  try {
    const spawn = fakeSpawnFactory((call) => {
      // The upstream leaf commits; the downstream leaf must SEE that commit.
      if (call.opts.cwd.endsWith("wt-feat")) {
        writeFileSync(join(call.opts.cwd, "helper.txt"), "the helper\n");
        commitAll(call.opts.cwd, "add helper");
      } else if (call.opts.cwd.endsWith("wt-migrate")) {
        // Do real work, so the tree survives collect() and can be inspected.
        writeFileSync(join(call.opts.cwd, "migrated.txt"), "uses the helper\n");
        commitAll(call.opts.cwd, "migrate");
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        { id: "helper", prompt: "h", model: "haiku", allowedTools: "Read,Edit,Bash",
          cwd: repo, originalCwd: repo, isolation: { worktree: "feat" }, worktreeName: "feat",
          timeoutMs: 5000, after: [] },
        { id: "migrate", prompt: "m", model: "haiku", allowedTools: "Read,Edit,Bash",
          cwd: repo, originalCwd: repo, isolation: { worktree: "migrate", from: "helper" },
          worktreeName: "migrate", from: "helper", timeoutMs: 5000, after: ["helper"] },
      ],
    };
    await runPlan(p, CFG, io);
    const migrateCall = spawn.calls.find((c) => String(c.opts.cwd).endsWith("wt-migrate"));
    ok(migrateCall, "the migrate leaf ran in its own tree");
    ok(existsSync(join(migrateCall.opts.cwd, "helper.txt")),
      "a from-based tree contains its dependency's committed work");
  } finally { cleanup(repo, dir); }
});

test("a from-based leaf that does nothing is still swept", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-sweep-"));
  try {
    const up = prepareIsolation({ id: "helper", originalCwd: repo, worktreeName: "helper" }, CFG, results);
    writeFileSync(join(up.path, "helper.txt"), "helper\n");
    commitAll(up.path, "helper");

    // Downstream bases on helper's branch and adds NOTHING of its own. Its branch
    // inherits helper's commit from birth — measuring against repo HEAD would
    // read that as this leaf's work and keep an empty tree forever.
    const down = prepareIsolation(
      { id: "noop", originalCwd: repo, worktreeName: "noop", baseRef: "swarm/helper" }, CFG, results);
    const out = collect({ id: "noop" }, CFG, down, { isChainFollower: false });
    equal(out.kept, false, "an empty from-based tree is swept, not kept");
    ok(!git(["branch", "--list", "swarm/noop"], repo).includes("swarm/noop"));
  } finally { cleanup(repo, results); }
});

test("a squash-merged branch no longer blocks reuse; --force overrides an unlanded one", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-sq-"));
  try {
    const wt = prepareIsolation({ id: "p1", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    writeFileSync(join(wt.path, "work.txt"), "real work\n");
    commitAll(wt.path, "phase 1");
    spawnSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repo, windowsHide: true });

    // Unlanded work still blocks...
    const other = mkdtempSync(join(tmpdir(), "swarm-wt-sq2-"));
    let threw = null;
    try { prepareIsolation({ id: "p2", originalCwd: repo, worktreeName: "feat" }, CFG, other); }
    catch (e) { threw = e; }
    ok(threw && /unlanded/.test(threw.message), "unlanded commits still refuse");

    // ...but --force is the documented escape hatch.
    const forced = mkdtempSync(join(tmpdir(), "swarm-wt-sq3-"));
    const okWt = prepareIsolation(
      { id: "p3", originalCwd: repo, worktreeName: "feat" }, CFG, forced, { reset: true });
    ok(existsSync(okWt.path), "--force overrides the guard");
    spawnSync("git", ["worktree", "remove", "--force", okWt.path], { cwd: repo, windowsHide: true });
    cleanup(other, forced);

    // Squash-merge on a FRESH branch — the --force above already reset swarm/feat
    // to HEAD, so reusing it here would assert nothing.
    const sqDir = mkdtempSync(join(tmpdir(), "swarm-wt-sq4-"));
    const sq = prepareIsolation({ id: "sq", originalCwd: repo, worktreeName: "sq" }, CFG, sqDir);
    writeFileSync(join(sq.path, "sq.txt"), "squashed work\n");
    commitAll(sq.path, "sq work");
    spawnSync("git", ["worktree", "remove", "--force", sq.path], { cwd: repo, windowsHide: true });
    // Before the squash lands, that branch genuinely blocks.
    let blocked = null;
    const preDir = mkdtempSync(join(tmpdir(), "swarm-wt-sq5-"));
    try { prepareIsolation({ id: "sq2", originalCwd: repo, worktreeName: "sq" }, CFG, preDir); }
    catch (e) { blocked = e; }
    ok(blocked && /unlanded/.test(blocked.message), "unlanded work blocks before the squash");
    cleanup(preDir);
    // After squash-merging its CONTENT, git cherry reads it as landed.
    spawnSync("git", ["merge", "--squash", "swarm/sq"], { cwd: repo, windowsHide: true });
    commitAll(repo, "squashed sq");
    const after = mkdtempSync(join(tmpdir(), "swarm-wt-sq6-"));
    try {
      const reused = prepareIsolation({ id: "sq3", originalCwd: repo, worktreeName: "sq" }, CFG, after);
      ok(existsSync(reused.path), "a squash-merged branch is reusable");
    } finally { cleanup(after, sqDir); }
  } finally { cleanup(repo, results); }
});

test("integrate merges sibling branches into the target tree", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int-"));
  try {
    const base = prepareIsolation({ id: "helper", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    writeFileSync(join(base.path, "helper.txt"), "helper\n");
    commitAll(base.path, "helper");

    for (const id of ["x", "y"]) {
      const wt = prepareIsolation(
        { id, originalCwd: repo, worktreeName: id, baseRef: "swarm/feat" }, CFG, results);
      writeFileSync(join(wt.path, `${id}.txt`), `${id} work\n`);
      commitAll(wt.path, `${id} work`);
    }

    const out = integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results, { repo });

    equal(out.conflicts.length, 0, "disjoint files merge cleanly");
    ok(existsSync(join(out.path, "x.txt")) && existsSync(join(out.path, "y.txt")),
      "both siblings' work is present in the target tree");
  } finally { cleanup(repo, results); }
});

test("integrate leaves conflict markers in place and reports the paths", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-wt-int2-"));
  try {
    const base = prepareIsolation({ id: "helper", originalCwd: repo, worktreeName: "feat" }, CFG, results);
    writeFileSync(join(base.path, "shared.txt"), "original\n");
    commitAll(base.path, "base");

    for (const [id, text] of [["x", "x version\n"], ["y", "y version\n"]]) {
      const wt = prepareIsolation(
        { id, originalCwd: repo, worktreeName: id, baseRef: "swarm/feat" }, CFG, results);
      writeFileSync(join(wt.path, "shared.txt"), text);
      commitAll(wt.path, `${id} edits shared`);
    }

    const out = integrate(
      { id: "join", worktreeName: "feat", sources: ["swarm/x", "swarm/y"] }, CFG, results, { repo });

    deepEqual(out.conflicts, ["shared.txt"], "the conflicting path is reported");
    const body = readFileSync(join(out.path, "shared.txt"), "utf8");
    ok(body.includes("<<<<<<<") && body.includes(">>>>>>>"),
      "conflict markers are left for the next leaf to resolve");
    ok(out.merged.includes("swarm/x"), "the clean merge before the conflict still landed");
  } finally { cleanup(repo, results); }
});

test("scheduler integration: an integrate node merges sibling branches into the target tree", async () => {
  const repo = initRepo();
  const dir = mkdtempSync(join(tmpdir(), "swarm-wt-intsched-"));
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "helper.txt"), "helper\n");
        commitAll(cwd, "helper");
      } else if (cwd.endsWith("wt-mx")) {
        writeFileSync(join(cwd, "mx.txt"), "x work\n");
        commitAll(cwd, "mx");
      } else if (cwd.endsWith("wt-my")) {
        writeFileSync(join(cwd, "my.txt"), "y work\n");
        commitAll(cwd, "my");
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const leaf = (id, over) => ({
      id, prompt: "p", model: "haiku", allowedTools: "Read,Edit,Bash",
      cwd: repo, originalCwd: repo, timeoutMs: 5000, after: [], ...over,
    });
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        leaf("helper", { isolation: { worktree: "feat" }, worktreeName: "feat" }),
        leaf("mx", { after: ["helper"], isolation: { worktree: "mx", from: "helper" }, worktreeName: "mx", from: "helper" }),
        leaf("my", { after: ["helper"], isolation: { worktree: "my", from: "helper" }, worktreeName: "my", from: "helper" }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["mx", "my"], worktreeName: "feat",
          integrate: { into: "feat", from: ["mx", "my"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, "the node completes ok");
    deepEqual(res.outputJson.merged, ["swarm/mx", "swarm/my"], "task ids resolved to branch names");
    deepEqual(res.outputJson.conflicts, [], "disjoint files merged cleanly");
    const tree = join(p.resultsDir, "wt-feat");
    ok(existsSync(join(tree, "mx.txt")) && existsSync(join(tree, "my.txt")),
      "both siblings' work landed in the target tree");
  } finally { cleanup(repo, dir); }
});

test("groupFinal is the task nothing else in the group depends on, even across other groups", async () => {
  const repo = initRepo();
  const dir = mkdtempSync(join(tmpdir(), "swarm-wt-gf-"));
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      // The feat tree is entered twice: first by helper, later by cleanup.
      const tag = !cwd.endsWith("wt-feat") ? "mx"
        : existsSync(join(cwd, "helper.txt")) ? "cleanup" : "helper";
      writeFileSync(join(cwd, `${tag}.txt`), "work\n");
      commitAll(cwd, tag);
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const leaf = (id, over) => ({
      id, prompt: "p", model: "haiku", allowedTools: "Read,Edit,Bash",
      cwd: repo, originalCwd: repo, timeoutMs: 5000, after: [], ...over,
    });
    // feat = [helper, cleanup]; cleanup reaches helper ONLY through mx, which is
    // in a different group. A same-group-only dep scan makes helper the
    // collector and sweeps the tree before cleanup has run.
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        leaf("helper", { isolation: { worktree: "feat" }, worktreeName: "feat" }),
        leaf("mx", { after: ["helper"], isolation: { worktree: "mx", from: "helper" }, worktreeName: "mx", from: "helper" }),
        leaf("cleanup", { after: ["mx"], isolation: { worktree: "feat" }, worktreeName: "feat" }),
      ],
    };
    const r = await runPlan(p, CFG, io);
    const feat = (r.worktreesKept || []).find((w) => w.name === "feat");
    ok(feat, "the feat tree is kept");
    ok(/cleanup/.test(feat.diffstat || ""),
      `collection must happen after cleanup, not after helper — diffstat: ${feat.diffstat}`);
  } finally { cleanup(repo, dir); }
});
