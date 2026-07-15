import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareIsolation, collect } from "../src/worktree.mjs";
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
    equal(r.summary.worktreesKept[0].id, "impl");
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
