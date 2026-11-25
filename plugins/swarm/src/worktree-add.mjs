// One task's `git worktree add`: retried on timeout, with the debris a killed add
// leaves cleared first — but only debris this task alone can own.
import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { unlandedCount } from "./landed.mjs";
import { appendRunLog } from "./runlog-append.mjs";
import { STALE_AFTER_MS } from "./stale-lock.mjs";

export const ADD_ATTEMPTS = 3;
// A slow add usually clears within seconds; this is breathing room, not a backoff.
const RETRY_PAUSE_MS = 1500;
// Only these two can hold up a checkout; anything else in the hooks dir cannot be blamed.
const SLOW_HOOKS = ["post-checkout", "reference-transaction"];

// The add as a child process, not spawnSync: a launch's await must not freeze every
// other leaf's callbacks and stop requests for the length of the timeout.
function gitAsync(args, cwd, { timeout, env }) {
  return new Promise((settle) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    try { child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; }); } catch { /* spawn failed */ }
    try { child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; }); } catch { /* spawn failed */ }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeout);
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle({ status, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

const pause = (ms) => new Promise((resume) => setTimeout(resume, ms));

function samePathRecorded(stdout, path) {
  const key = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const want = key(path);
  return stdout.split("\n").some((l) => l.startsWith("worktree ") && key(l.slice("worktree ".length).trim()) === want);
}

function lockPathFor(repo, branch, git) {
  const r = git(["rev-parse", "--git-path", `refs/heads/${branch}.lock`], repo, { timeout: 60000 });
  return r.status === 0 && r.stdout ? resolve(repo, r.stdout) : null;
}

// The hook that can hold a checkout up, or null. Presence only: Windows reports every
// file as mode 100666, and git never executes a `*.sample` name.
export function slowHook(repo, { git }) {
  const r = git(["rev-parse", "--git-path", "hooks"], repo, { timeout: 60000 });
  if (r.status !== 0 || !r.stdout) return null;
  const dir = resolve(repo, r.stdout);
  const found = SLOW_HOOKS.filter((name) => existsSync(resolve(dir, name)));
  return found.length ? found.join(" / ") : null;
}

// "3 attempts" and the final budget are the two facts a reader needs to tell a slow
// repo from a hung one; the hook is named only when the repo actually has one.
export function timeoutMessage({ repo, task, attempts, timeoutMs, git }) {
  const hook = slowHook(repo, { git });
  const tries = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  const cause = hook
    ? `a slow repo hook (${hook}) is the usual cause`
    : "the repo was slow to check out — likely contention from concurrent runs or a large object store";
  return `git worktree add timed out after ${timeoutMs / 1000}s (${tries}) for '${task.id}' — ${cause}`;
}

// Clear what a killed add of THIS task left: its tree, its branch lock, and nothing
// else. Anything that cannot be proven this task's own stops the retry instead.
export function clearTaskDebris({ repo, path, branch, branchDerived = true, existedBefore = false, git }) {
  const listed = git(["worktree", "list", "--porcelain"], repo, { timeout: 60000 });
  const registered = listed.status === 0 && samePathRecorded(listed.stdout, path);
  if (registered) {
    // A tree a killed add left registered may still be locked; only -f -f removes one.
    const removed = git(["worktree", "remove", "-f", "-f", path], repo, { timeout: 60000 });
    if (removed.status !== 0 && existsSync(path)) {
      throw new Error(`could not remove the half-made tree at ${path}: ${removed.stderr || removed.stdout}`);
    }
  } else if (existsSync(path)) {
    if (existedBefore) throw new Error(`the directory at ${path} existed before this attempt — refusing to delete it`);
    rmSync(path, { recursive: true, force: true });
  }
  if (existsSync(repo)) git(["worktree", "prune"], repo, { timeout: 60000 });

  // A live writer fills a lock within milliseconds, so an empty one whose mtime has not
  // moved for a staleness window has no writer — whatever else is running in the repo.
  const lock = lockPathFor(repo, branch, git);
  if (!lock || !existsSync(lock)) return;
  if (!branchDerived) {
    throw new Error(`the lock at ${lock} belongs to the manifest-declared branch '${branch}' — only a swarm-derived branch is this task's alone`);
  }
  const first = statSync(lock);
  if (first.size > 0) throw new Error(`the lock at ${lock} has content — a writer may hold it`);
  if (Date.now() - first.mtimeMs < STALE_AFTER_MS) {
    throw new Error(`the lock at ${lock} was written within the last ${Math.round(STALE_AFTER_MS / 1000)}s — a writer may hold it`);
  }
  const again = statSync(lock);
  if (again.size > 0 || again.mtimeMs !== first.mtimeMs) {
    throw new Error(`the lock at ${lock} changed while it was checked — a writer holds it`);
  }
  rmSync(lock, { force: true });
}

async function addOnce({ repo, path, branch, base, budget, env, task, cfg, reset, git }) {
  const add = await gitAsync(["worktree", "add", path, "-b", branch, "--no-track", base], repo, { timeout: budget, env });
  if (add.status === 0 || add.timedOut || !/already exists/i.test(add.stderr)) return add;
  // The path was cleared but the branch lingered. -B RESETS the branch, so refuse when
  // it still carries unlanded work; "unlanded" is measured against the landing places a
  // run can see, never this run's pinned base, which predates work already merged on.
  const unlanded = unlandedCount(branch, repo, { prefix: cfg.worktreeBranchPrefix || "swarm/", gitRunner: git, extraBases: [] });
  if (unlanded > 0 && !reset) {
    throw new Error(
      `worktree branch '${branch}' carries ${unlanded === Infinity ? "an unknown number of" : unlanded} unlanded commit(s) — refusing to reset it ` +
      `for task '${task.id}'. That work came from an earlier run and would be lost.\n` +
      `    inspect:  git log ${branch}\n` +
      `    reuse it: name a different worktree, merge/delete '${branch}' yourself, or re-run with --force`);
  }
  return gitAsync(["worktree", "add", path, "-B", branch, "--no-track", base], repo, { timeout: budget, env });
}

// Attempts double their budget, and only a TIMEOUT retries: a real git error is the
// repo's answer, not a stall. Returns the last attempt's result either way.
export async function addWorktree({ repo, path, branch, base, addTimeoutMs, env, task, cfg, resultsDir, reset, git, existedBefore }) {
  let budget = addTimeoutMs;
  for (let attempt = 1; attempt <= ADD_ATTEMPTS; attempt++) {
    const add = await addOnce({ repo, path, branch, base, budget, env, task, cfg, reset, git });
    if (add.status === 0 || !add.timedOut || attempt === ADD_ATTEMPTS) return { add, attempts: attempt, timeoutMs: budget };
    try {
      clearTaskDebris({ repo, path, branch, branchDerived: !task.branchName, existedBefore, git });
    } catch (e) {
      throw new Error(`${e.message}\n    the attempt before it timed out after ${budget / 1000}s, so it was not retried`);
    }
    budget *= 2;
    appendRunLog(resultsDir, {
      ts: new Date().toISOString(), event: "worktree-add-retry",
      id: task.id, attempt: attempt + 1, timeoutMs: budget,
    });
    await pause(RETRY_PAUSE_MS);
  }
  return { add: null, attempts: ADD_ATTEMPTS, timeoutMs: budget };
}
