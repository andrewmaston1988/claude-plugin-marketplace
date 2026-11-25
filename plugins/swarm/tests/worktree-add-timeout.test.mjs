import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareIsolation, treeDirFor } from "../src/worktree.mjs";
import { ADD_ATTEMPTS, clearTaskDebris, slowHook, timeoutMessage } from "../src/worktree-add.mjs";
import { STALE_AFTER_MS } from "../src/stale-lock.mjs";
import { initRepo, cleanup, git, CFG } from "./helpers/worktree-fixtures.mjs";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitUntil(pred, ms) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) sleep(50);
}

// A killed git leaves hooks alive holding their cwd; retry the delete until they exit.
function removeEventually(dir) {
  for (const stop = Date.now() + 20000; ; sleep(100)) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) { if (Date.now() > stop) throw e; }
  }
}

const hookPath = (...parts) => join(...parts).replaceAll("\\", "/");

function readLog(resultsDir) {
  try {
    return readFileSync(join(resultsDir, "run.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function lockPathFor(repo, branch) {
  return resolve(repo, git(["rev-parse", "--git-path", `refs/heads/${branch}.lock`], repo));
}

function ageLock(lock, ms) {
  const old = new Date(Date.now() - ms);
  utimesSync(lock, old, old);
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "swarm-wt-debris-"));
}

function hooksDir() {
  return mkdtempSync(join(tmpdir(), "swarm-wt-hooks-"));
}

function resultsDir() {
  return mkdtempSync(join(tmpdir(), "swarm-wt-res-"));
}

// A first-run-only slow post-checkout hook: the killed attempt's hook outlives the
// timeout, then every later invocation returns at once.
function firstRunSlowHook(dir, doneMarker, delayMs = 1400) {
  const done = hookPath(doneMarker);
  const script = `#!/bin/sh\nif [ ! -f '${done}' ]; then\n  node -e "setTimeout(() => require('fs').writeFileSync('${done}', ''), ${delayMs})"\nfi\n`;
  writeFileSync(join(dir, "post-checkout"), script, { mode: 0o755 });
}

// ---- the retry loop

test("a timed-out add retries and yields a ready tree, recording the retry", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const done = join(hooks, "done");
  try {
    firstRunSlowHook(hooks, done);
    git(["config", "core.hooksPath", hooks], repo);
    const wt = await prepareIsolation({ id: "slow", originalCwd: repo }, CFG, results,
      { addTimeoutMs: 800, base: git(["rev-parse", "HEAD"], repo) });

    equal(wt.reused, false);
    ok(existsSync(join(wt.path, "a.txt")), "the retried add produced a real tree");
    const retries = readLog(results).filter((e) => e.event === "worktree-add-retry");
    equal(retries.length, 1, "one timeout, one retry");
    equal(retries[0].attempt, 2);
    equal(retries[0].timeoutMs, 1600, "the retry's budget is double the first attempt's");
  } finally {
    waitUntil(() => existsSync(done), 20000);
    for (const d of [results, hooks, repo]) removeEventually(d);
  }
});

test("every attempt timing out throws after the last, with doubling budgets", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const count = join(hooks, "count");
  try {
    writeFileSync(join(hooks, "post-checkout"),
      `#!/bin/sh\nprintf x >> '${hookPath(count)}'\nnode -e "setTimeout(() => {}, 600)"\n`, { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], repo);

    let error;
    try {
      await prepareIsolation({ id: "hung", originalCwd: repo }, CFG, results,
        { addTimeoutMs: 400, base: git(["rev-parse", "HEAD"], repo) });
    } catch (e) { error = e; }

    ok(error, "a permanently slow add throws");
    ok(/timed out after 1\.6s/.test(error.message), error.message);
    ok(new RegExp(`after ${ADD_ATTEMPTS} attempts`).test(error.message), error.message);
    ok(/post-checkout/.test(error.message), `the present hook is named: ${error.message}`);
    const retries = readLog(results).filter((e) => e.event === "worktree-add-retry");
    equal(retries.length, 2, "two retries between three attempts");
    equal(retries.map((e) => e.attempt).join(","), "2,3");
    equal(retries.map((e) => e.timeoutMs).join(","), "800,1600", "each budget doubles");
  } finally {
    waitUntil(() => existsSync(count), 20000);
    for (const d of [results, hooks, repo]) removeEventually(d);
  }
});

test("a non-timeout add failure throws on the first attempt with no retry", { timeout: 30000 }, async () => {
  const repo = initRepo();
  const results = resultsDir();
  try {
    let error;
    try {
      await prepareIsolation({ id: "bad", originalCwd: repo }, CFG, results,
        { addTimeoutMs: 5000, base: "0".repeat(40) });
    } catch (e) { error = e; }
    ok(error, "a real git failure still throws");
    ok(/git worktree add failed/.test(error.message), error.message);
    equal(readLog(results).filter((e) => e.event === "worktree-add-retry").length, 0,
      "only a timeout retries");
  } finally { removeEventually(results); cleanup(repo); }
});

test("an old 0-byte lock and the half-made tree are cleared before the retry", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const done = join(hooks, "done");
  const lock = lockPathFor(repo, "swarm/slow");
  const tree = treeDirFor(results, "slow", CFG);
  try {
    firstRunSlowHook(hooks, done);
    git(["config", "core.hooksPath", hooks], repo);

    const pending = prepareIsolation({ id: "slow", originalCwd: repo }, CFG, results,
      { addTimeoutMs: 800, base: git(["rev-parse", "HEAD"], repo) });
    // Once the attempt has made its tree, the ref is written and its lock is free:
    // seed the debris a killed add is known to leave.
    waitUntil(() => existsSync(tree), 10000);
    writeFileSync(lock, "");
    ageLock(lock, STALE_AFTER_MS + 5000);

    const wt = await pending;
    equal(wt.reused, false);
    ok(!existsSync(lock), "the dead lock was removed");
    ok(existsSync(join(wt.path, "a.txt")), "the retry produced a real tree");
    equal(readLog(results).filter((e) => e.event === "worktree-add-retry").length, 1);
  } finally {
    waitUntil(() => existsSync(done), 20000);
    for (const d of [results, hooks, repo]) removeEventually(d);
  }
});

// ---- the per-task debris clear

test("a lock with content is left in place and named in the error", () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "0123456789abcdef\n");
    let error;
    try { clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git }); }
    catch (e) { error = e; }
    ok(error, "a content lock refuses the clear");
    ok(error.message.includes(lock), `the error names the lock: ${error.message}`);
    ok(existsSync(lock), "a live writer's lock is never removed");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a 0-byte lock written inside the staleness window is left in place", () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    let error;
    try { clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git }); }
    catch (e) { error = e; }
    ok(error, "a young lock refuses the clear");
    ok(error.message.includes(lock), error.message);
    ok(existsSync(lock), "a lock whose mtime moved within the window is never removed");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a lock on another branch is left untouched", () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const other = lockPathFor(repo, "swarm/other");
    mkdirSync(resolve(other, ".."), { recursive: true });
    writeFileSync(other, "");
    clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git });
    ok(existsSync(other), "another task's branch lock is none of this task's business");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a lock on a manifest-declared branch is left in place and named", () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const lock = lockPathFor(repo, "feature/shared");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    ageLock(lock, STALE_AFTER_MS + 5000);
    let error;
    try { clearTaskDebris({ repo, path: join(dir, "tree"), branch: "feature/shared", branchDerived: false, existedBefore: false, git }); }
    catch (e) { error = e; }
    ok(error, "a declared branch's lock is not this task's alone");
    ok(error.message.includes(lock), error.message);
    ok(existsSync(lock), "the declared branch's lock survives");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a registered, locked half-made tree is removed", () => {
  const repo = initRepo();
  const dir = scratch();
  const tree = join(dir, "tree");
  try {
    git(["worktree", "add", "-b", "swarm/locked", tree, "--no-track", "HEAD"], repo);
    git(["worktree", "lock", tree], repo);
    clearTaskDebris({ repo, path: tree, branch: "swarm/locked", branchDerived: true, existedBefore: true, git });
    ok(!existsSync(tree), "only -f -f can remove a locked tree, and it must go");
    ok(!git(["worktree", "list", "--porcelain"], repo).includes("swarm/locked"), "its registration is gone too");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("an unregistered directory created by this attempt is removed", () => {
  const repo = initRepo();
  const dir = scratch();
  const leftover = join(dir, "half");
  try {
    mkdirSync(leftover);
    writeFileSync(join(leftover, "partial.txt"), "half-checked-out\n");
    clearTaskDebris({ repo, path: leftover, branch: "swarm/half", branchDerived: true, existedBefore: false, git });
    ok(!existsSync(leftover), "the attempt's own half-made directory is debris");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a directory that existed before the attempt is not removed", () => {
  const repo = initRepo();
  const dir = scratch();
  const held = join(dir, "mine");
  try {
    mkdirSync(held);
    writeFileSync(join(held, "notes.txt"), "user data\n");
    let error;
    try { clearTaskDebris({ repo, path: held, branch: "swarm/mine", branchDerived: true, existedBefore: true, git }); }
    catch (e) { error = e; }
    ok(error, "the clear refuses a directory it did not create");
    ok(error.message.includes(held), error.message);
    ok(existsSync(join(held, "notes.txt")), "user data is never deleted");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a branch carrying unlanded commits is never deleted or reset by the clear", () => {
  const repo = initRepo();
  const dir = scratch();
  const tree = join(dir, "keep");
  try {
    git(["worktree", "add", "-b", "swarm/keep", tree, "--no-track", "HEAD"], repo);
    writeFileSync(join(tree, "keep.txt"), "keep\n");
    git(["add", "."], tree);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "keep"], tree);
    const tip = git(["rev-parse", "swarm/keep"], repo);
    git(["worktree", "remove", "--force", tree], repo);

    clearTaskDebris({ repo, path: tree, branch: "swarm/keep", branchDerived: true, existedBefore: false, git });
    equal(git(["rev-parse", "swarm/keep"], repo), tip, "the branch and its commit survive the clear");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

// ---- the timeout message names a hook only when the repo has one

test("with no hooks the timeout names contention, not a hook", () => {
  const repo = initRepo();
  try {
    git(["config", "core.hooksPath", join(repo, ".git", "hooks")], repo);
    const message = timeoutMessage({ repo, task: { id: "t" }, attempts: 3, timeoutMs: 720000, git });
    ok(/timed out after 720s/.test(message), message);
    ok(/contention|large object store/.test(message), message);
    ok(!/post-checkout|reference-transaction/.test(message), `no hook is named: ${message}`);
    equal(slowHook(repo, { git }), null, "only *.sample files are present");
  } finally { cleanup(repo); }
});

test("a hook with no execute bits is still detected", () => {
  const repo = initRepo();
  const hooks = hooksDir();
  try {
    writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\n", { mode: 0o644 });
    git(["config", "core.hooksPath", hooks], repo);
    equal(slowHook(repo, { git }), "post-checkout", "presence, not an execute bit, is the test");
  } finally { removeEventually(hooks); cleanup(repo); }
});

test("a hook in a linked worktree's common dir is detected", () => {
  const repo = initRepo();
  const dir = scratch();
  const linked = join(dir, "linked");
  try {
    const common = resolve(repo, git(["rev-parse", "--git-common-dir"], repo));
    mkdirSync(join(common, "hooks"), { recursive: true });
    writeFileSync(join(common, "hooks", "reference-transaction"), "#!/bin/sh\n", { mode: 0o644 });
    git(["worktree", "add", linked, "-b", "linked", "--no-track", "HEAD"], repo);
    equal(slowHook(linked, { git }), "reference-transaction", "the common dir's hooks are the worktree's hooks");
  } finally { removeEventually(dir); cleanup(repo); }
});

test("a reference-transaction hook is named in the timeout", () => {
  const repo = initRepo();
  const hooks = hooksDir();
  try {
    writeFileSync(join(hooks, "reference-transaction"), "#!/bin/sh\n", { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], repo);
    const message = timeoutMessage({ repo, task: { id: "t" }, attempts: 3, timeoutMs: 720000, git });
    ok(/reference-transaction/.test(message), message);
  } finally { removeEventually(hooks); cleanup(repo); }
});

// ---- argument validation

test("prepareIsolation requires addTimeoutMs and names it in the error", () => {
  for (const opts of [undefined, {}, { addTimeoutMs: 0 }, { addTimeoutMs: "5" }]) {
    let error;
    try { prepareIsolation({ id: "x", originalCwd: "." }, CFG, ".", opts); } catch (e) { error = e; }
    ok(error, `throws for ${JSON.stringify(opts)}`);
    ok(/addTimeoutMs/.test(error.message), error.message);
  }
});

