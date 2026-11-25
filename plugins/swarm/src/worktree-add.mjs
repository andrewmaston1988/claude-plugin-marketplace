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
// A killed git's hooks inherit its pipes and outlive it, so `close` can wait forever.
// The attempt settles on this deadline instead, capped by its own budget.
const KILL_GRACE_MS = 5000;
// How often a running attempt checks for a stop request.
const CANCEL_POLL_MS = 100;
// A dying process releases its cwd within moments; this is the bound on waiting for it.
const REMOVE_TRIES = 20;
const REMOVE_RETRY_MS = 250;

// Killing git alone leaves its hooks alive, and a live hook pins the directory the
// retry has to remove. taskkill walks the tree on Windows and its exit is the reap;
// a POSIX process group does the same job, which is why the child spawns detached.
function killTree(child) {
  if (!child.pid) {
    try { child.kill(); } catch { /* already gone */ }
    return null;
  }
  if (process.platform === "win32") {
    return new Promise((reaped) => {
      const fallback = () => { try { child.kill(); } catch { /* already gone */ } reaped(); };
      let killer;
      try {
        killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch { fallback(); return; }
      killer.on("error", fallback);
      killer.on("close", (code) => { if (code === 0) reaped(); else fallback(); });
    });
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill(); } catch { /* already gone */ } }
  return null;
}

// The add as a child process, not spawnSync: a launch's await must not freeze every
// other leaf's callbacks and stop requests for the length of the timeout.
function gitAsync(args, cwd, { timeout, env, graceMs = Math.min(KILL_GRACE_MS, timeout), isCancelled }) {
  return new Promise((settle) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Merged over the parent's, as the synchronous runner does: a bare map drops
      // PATH and every Git setting the user reaches git through (GIT_*, HOME).
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let done = false;
    let timer = null;
    let poll = null;
    let grace = null;
    let reaping = null;
    try { child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; }); } catch { /* spawn failed */ }
    try { child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; }); } catch { /* spawn failed */ }
    const finishNow = (status, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (grace) clearTimeout(grace);
      settle({ status, stdout: stdout.trim(), stderr: stderr.trim(), timedOut, cancelled, ...(error && { error }) });
    };
    // Nothing downstream may start until the whole tree is gone: a dying hook still
    // pins the tree the retry has to delete.
    const finish = (status, error) => {
      if (done) return;
      if (reaping) { reaping.then(() => finishNow(status, error)); return; }
      finishNow(status, error);
    };
    // A surviving hook holds the pipes open, so `close` may never arrive.
    const deadline = () => { if (!grace) grace = setTimeout(() => finishNow(null), graceMs); };
    const stop = (why) => {
      if (timedOut || cancelled) return;
      if (why === "timeout") timedOut = true; else cancelled = true;
      reaping = killTree(child);
      deadline();
    };
    timer = setTimeout(() => stop("timeout"), timeout);
    if (isCancelled) poll = setInterval(() => { if (isCancelled()) stop("cancelled"); }, CANCEL_POLL_MS);
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

// Debris and diagnostic git calls go through this: a synchronous 60-second call in
// the retry path freezes every other leaf's callbacks for as long as it blocks.
export const gitRunAsync = (args, cwd, { timeout = 60000 } = {}) => gitAsync(args, cwd, { timeout });

function pause(ms, isCancelled) {
  return new Promise((resume) => {
    const until = Date.now() + ms;
    const tick = setInterval(() => {
      if (isCancelled?.() || Date.now() >= until) { clearInterval(tick); resume(); }
    }, CANCEL_POLL_MS);
  });
}

function samePathRecorded(stdout, path) {
  const key = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const want = key(path);
  return stdout.split("\n").some((l) => l.startsWith("worktree ") && key(l.slice("worktree ".length).trim()) === want);
}

async function lockPathFor(repo, branch, git) {
  const r = await git(["rev-parse", "--git-path", `refs/heads/${branch}.lock`], repo, { timeout: 60000 });
  return r.status === 0 && r.stdout ? resolve(repo, r.stdout) : null;
}

// The hook that can hold a checkout up, or null. Presence only: Windows reports every
// file as mode 100666, and git never executes a `*.sample` name.
export async function slowHook(repo, { git }) {
  const r = await git(["rev-parse", "--git-path", "hooks"], repo, { timeout: 60000 });
  if (r.status !== 0 || !r.stdout) return null;
  const dir = resolve(repo, r.stdout);
  const found = SLOW_HOOKS.filter((name) => existsSync(resolve(dir, name)));
  return found.length ? found.join(" / ") : null;
}

// "3 attempts" and the final budget are the two facts a reader needs to tell a slow
// repo from a hung one; the hook is named only when the repo actually has one. The
// ladder spends every attempt's budget, so the number is named as a budget, never as
// elapsed time.
export async function timeoutMessage({ repo, task, attempts, timeoutMs, git }) {
  const hook = await slowHook(repo, { git });
  const tries = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  const cause = hook
    ? `a slow repo hook (${hook}) is the usual cause`
    : "the repo was slow to check out — likely contention from concurrent runs or a large object store";
  return `git worktree add timed out for '${task.id}' after ${tries}, the last with a ${timeoutMs / 1000}s budget — ${cause}`;
}

// A just-killed process can hold its cwd for a moment, so a removal that fails is
// retried briefly rather than read as a tree that will not go.
async function removeRegistered(repo, path, git) {
  for (let tries = 0; ; tries++) {
    const removed = await git(["worktree", "remove", "-f", "-f", path], repo, { timeout: 60000 });
    if (removed.status === 0 || !existsSync(path)) return;
    if (tries >= REMOVE_TRIES) {
      throw new Error(`could not remove the half-made tree at ${path}: ${removed.stderr || removed.stdout}`);
    }
    await pause(REMOVE_RETRY_MS);
  }
}

async function removeDirectory(path) {
  for (let tries = 0; ; tries++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch (e) {
      if (tries >= REMOVE_TRIES) throw new Error(`could not remove the half-made directory at ${path}: ${e.message}`);
      await pause(REMOVE_RETRY_MS);
    }
  }
}

// Clear what a killed add of THIS task left: its tree, its branch lock, and nothing
// else. Anything that cannot be proven this task's own stops the retry instead.
export async function clearTaskDebris({
  repo, path, branch, branchDerived = true, existedBefore = false, git, lockWindowMs = STALE_AFTER_MS,
}) {
  const listed = await git(["worktree", "list", "--porcelain"], repo, { timeout: 60000 });
  const registered = listed.status === 0 && samePathRecorded(listed.stdout, path);
  if (registered) {
    // A tree a killed add left registered may still be locked; only -f -f removes one.
    await removeRegistered(repo, path, git);
  } else if (existsSync(path)) {
    if (existedBefore) throw new Error(`the directory at ${path} existed before this attempt — refusing to delete it`);
    await removeDirectory(path);
  }
  if (existsSync(repo)) await git(["worktree", "prune"], repo, { timeout: 60000 });

  // A live writer fills a lock within milliseconds, so an empty one watched for a
  // whole staleness window without changing has no writer — whatever else is running
  // in the repo. Two reads taken back to back prove nothing: they agree on anything.
  const lock = await lockPathFor(repo, branch, git);
  if (!lock || !existsSync(lock)) return;
  if (!branchDerived) {
    throw new Error(`the lock at ${lock} belongs to the manifest-declared branch '${branch}' — only a swarm-derived branch is this task's alone`);
  }
  const first = statSync(lock);
  if (first.size > 0) throw new Error(`the lock at ${lock} has content — a writer may hold it`);
  if (Date.now() - first.mtimeMs < lockWindowMs) {
    throw new Error(`the lock at ${lock} was written within the last ${Math.round(lockWindowMs / 1000)}s — a writer may hold it`);
  }
  await pause(lockWindowMs);
  let again;
  try {
    again = statSync(lock);
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  if (again.size > 0 || again.mtimeMs !== first.mtimeMs) {
    throw new Error(`the lock at ${lock} changed while it was checked — a writer holds it`);
  }
  rmSync(lock, { force: true });
}

async function addOnce({ repo, path, branch, base, budget, env, task, cfg, reset, git, isCancelled }) {
  const add = await gitAsync(["worktree", "add", path, "-b", branch, "--no-track", base], repo, { timeout: budget, env, isCancelled });
  if (add.cancelled || add.status === 0 || add.timedOut || !/already exists/i.test(add.stderr)) return add;
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
  return gitAsync(["worktree", "add", path, "-B", branch, "--no-track", base], repo, { timeout: budget, env, isCancelled });
}

// Attempts double their budget, and only a TIMEOUT retries: a real git error is the
// repo's answer, not a stall. Returns the last attempt's result either way.
export async function addWorktree({
  repo, path, branch, base, addTimeoutMs, env, task, cfg, resultsDir, reset, git, existedBefore, isCancelled, lockWindowMs,
}) {
  let budget = addTimeoutMs;
  for (let attempt = 1; attempt <= ADD_ATTEMPTS; attempt++) {
    const add = await addOnce({ repo, path, branch, base, budget, env, task, cfg, reset, git, isCancelled });
    if (add.cancelled) return { add, attempts: attempt, timeoutMs: budget, cancelled: true };
    if (add.status === 0 || !add.timedOut || attempt === ADD_ATTEMPTS) return { add, attempts: attempt, timeoutMs: budget };
    try {
      await clearTaskDebris({ repo, path, branch, branchDerived: !task.branchName, existedBefore, git: gitRunAsync, lockWindowMs });
    } catch (e) {
      // The timed-out add's own output is part of the cause a reader needs.
      const said = add.stderr ? `\n    the timed-out attempt said: ${add.stderr}` : "";
      throw new Error(`${e.message}${said}\n    the attempt before it timed out after ${budget / 1000}s, so it was not retried`);
    }
    budget *= 2;
    appendRunLog(resultsDir, {
      ts: new Date().toISOString(), event: "worktree-add-retry",
      id: task.id, attempt: attempt + 1, timeoutMs: budget,
    });
    await pause(RETRY_PAUSE_MS, isCancelled);
    if (isCancelled?.()) return { add: null, attempts: attempt, timeoutMs: budget, cancelled: true };
  }
}
