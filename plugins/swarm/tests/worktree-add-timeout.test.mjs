import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareIsolation, treeDirFor } from "../src/worktree.mjs";
import { addWorktree, clearTaskDebris, gitRunAsync, slowHook, timeoutMessage } from "../src/worktree-add.mjs";
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

// worktree.mjs's runner shape: a result object, never a throw.
function gitRun(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

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

// A post-checkout hook that hangs only while its flag file exists, removing the flag as
// it starts: the killed attempt's hook outlives the timeout, later invocations return at
// once, and a test can watch the flag go to know the branch ref is already written.
function hangOnceHook(dir, flagMarker, hangMs = 3000) {
  const flag = hookPath(flagMarker);
  const script = `#!/bin/sh\nif [ -f '${flag}' ]; then\n  rm -f '${flag}'\n  node -e "setTimeout(() => {}, ${hangMs})"\nfi\n`;
  writeFileSync(join(dir, "post-checkout"), script, { mode: 0o755 });
  writeFileSync(flagMarker, "");
}

// ---- the retry loop

test("a timed-out add retries and yields a ready tree, recording the retry", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const flag = join(hooks, "hang");
  try {
    // The hook hangs far longer than the first budget, so the retry's own budget has
    // real headroom: a slow second attempt is still a second attempt.
    hangOnceHook(hooks, flag, 30000);
    git(["config", "core.hooksPath", hooks], repo);
    const wt = await prepareIsolation({ id: "slow", originalCwd: repo }, CFG, results,
      { addTimeoutMs: 6000, base: git(["rev-parse", "HEAD"], repo) });

    equal(wt.reused, false);
    ok(existsSync(join(wt.path, "a.txt")), "the retried add produced a real tree");
    const retries = readLog(results).filter((e) => e.event === "worktree-add-retry");
    equal(retries.length, 1, "one timeout, one retry");
    equal(retries[0].attempt, 2);
    equal(retries[0].timeoutMs, 12000, "the retry's budget is double the first attempt's");
  } finally {
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
      `#!/bin/sh\nprintf x >> '${hookPath(count)}'\nnode -e "setTimeout(() => {}, 3000)"\n`, { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], repo);

    let error;
    try {
      await prepareIsolation({ id: "hung", originalCwd: repo }, CFG, results,
        { addTimeoutMs: 400, base: git(["rev-parse", "HEAD"], repo) });
    } catch (e) { error = e; }

    ok(error, "a permanently slow add throws");
    ok(/timed out for 'hung' after 3 attempts, the last with a 1\.6s budget/.test(error.message), error.message);
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

// The add is a child process, so it inherits what the sync runner inherits. Git settings
// reach a user's git through the environment (`GIT_CONFIG_*`), and a bare env map drops
// them along with PATH and HOME.
test("the add inherits the parent's git configuration", { timeout: 30000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const marker = join(hooks, "ran");
  try {
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nprintf x > '${hookPath(marker)}'\n`, { mode: 0o755 });
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = hooks;
    const wt = await prepareIsolation({ id: "env", originalCwd: repo }, CFG, results,
      { addTimeoutMs: 20000, base: git(["rev-parse", "HEAD"], repo) });
    ok(existsSync(join(wt.path, "a.txt")), "the add produced a real tree");
    ok(existsSync(marker), "a git setting the parent holds in its environment reached the add");
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    for (const d of [results, hooks, repo]) removeEventually(d);
  }
});

// A hook's orphaned child inherits git's pipes, so `close` alone would let one such
// child hold a call open far past its own budget.
test("a hook's orphan cannot hold the call past its deadline", { timeout: 120000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const dir = scratch();
  const release = hookPath(dir, "release");
  try {
    // The child sleeps elsewhere so it pins nothing git touched, and exits on the flag
    // so cleanup is not left waiting on it.
    writeFileSync(join(hooks, "post-checkout"),
      `#!/bin/sh\n(cd '${hookPath(dir)}' && node -e "` +
      `const fs=require('fs'),until=Date.now()+40000,t=setInterval(()=>{` +
      `if(fs.existsSync('${release}')||Date.now()>until){clearInterval(t);process.exit(0)}},100)") &\nexit 0\n`,
      { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], repo);
    const started = Date.now();
    const r = await gitRunAsync(["checkout", "-b", "held-open"], repo, { timeout: 500 });
    const took = Date.now() - started;
    equal(r.timedOut, true, "the call reports a timeout");
    ok(took < 6000, `the call settled at its deadline, not when the orphan let go: ${took}ms`);
  } finally {
    writeFileSync(release, "");
    for (const d of [hooks, repo]) removeEventually(d);
    removeEventually(dir);
  }
});

test("a stop request aborts the add instead of waiting out its budget", { timeout: 30000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const dir = scratch();
  try {
    writeFileSync(join(hooks, "post-checkout"), '#!/bin/sh\nnode -e "setTimeout(() => {}, 30000)"\n', { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], repo);
    let stopped = false;
    setTimeout(() => { stopped = true; }, 200);
    const started = Date.now();
    const out = await addWorktree({
      repo, path: join(dir, "tree"), branch: "swarm/stopped", base: git(["rev-parse", "HEAD"], repo),
      addTimeoutMs: 30000, env: {}, task: { id: "stopped" }, cfg: CFG, resultsDir: results, git: gitRun,
      isCancelled: () => stopped,
    });
    ok(out.cancelled, "a stopped add reports itself cancelled");
    equal(out.attempts, 1, "a stop is not retried");
    ok(Date.now() - started < 10000, `the add did not run out its 30s budget: ${Date.now() - started}ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); for (const d of [results, hooks, repo]) removeEventually(d); }
});

test("a clear that fails still reports the timed-out attempt", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const dir = scratch();
  const flag = join(hooks, "hang");
  const lock = lockPathFor(repo, "swarm/held");
  try {
    hangOnceHook(hooks, flag, 30000);
    git(["config", "core.hooksPath", hooks], repo);
    const pending = prepareIsolation({ id: "held", originalCwd: repo }, CFG, results,
      { addTimeoutMs: 1500, base: git(["rev-parse", "HEAD"], repo) });
    // The hook running means the branch ref is written, so a lock seeded now is a
    // writer's lock and the clear must refuse it.
    waitUntil(() => !existsSync(flag), 20000);
    writeFileSync(lock, "0123456789abcdef\n");
    let error;
    try { await pending; } catch (e) { error = e; }
    ok(error, "the retry stops rather than deleting a lock it cannot prove dead");
    ok(/has content/.test(error.message), error.message);
    ok(/timed out after 1\.5s/.test(error.message), `the timeout that led to it is still named: ${error.message}`);
    ok(/the timed-out attempt said: Preparing worktree/.test(error.message), `its own output survives the clear's failure: ${error.message}`);
  } finally { rmSync(dir, { recursive: true, force: true }); for (const d of [results, hooks, repo]) removeEventually(d); }
});

test("an old 0-byte lock and the half-made tree are cleared before the retry", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  const results = resultsDir();
  const flag = join(hooks, "hang");
  const lock = lockPathFor(repo, "swarm/slow");
  const tree = treeDirFor(results, "slow", CFG);
  const window = 300;
  try {
    hangOnceHook(hooks, flag);
    git(["config", "core.hooksPath", hooks], repo);

    const pending = prepareIsolation({ id: "slow", originalCwd: repo }, CFG, results,
      { addTimeoutMs: 2000, base: git(["rev-parse", "HEAD"], repo), lockWindowMs: window });
    // The flag going means the hook is running, so git has written the branch ref and
    // released its lock: seed the debris a killed add leaves while nothing holds it.
    waitUntil(() => !existsSync(flag), 20000);
    writeFileSync(lock, "");
    ageLock(lock, window + 2000);
    ok(existsSync(tree), "precondition: the killed attempt made a half tree");

    const wt = await pending;
    equal(wt.reused, false);
    ok(!existsSync(lock), "the dead lock was removed");
    ok(existsSync(join(wt.path, "a.txt")), "the retry produced a real tree");
    equal(readLog(results).filter((e) => e.event === "worktree-add-retry").length, 1);
  } finally {
    for (const d of [results, hooks, repo]) removeEventually(d);
  }
});

// ---- the per-task debris clear

test("a lock with content is left in place and named in the error", async () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "0123456789abcdef\n");
    let error;
    try { await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git: gitRun }); }
    catch (e) { error = e; }
    ok(error, "a content lock refuses the clear");
    ok(error.message.includes(lock), `the error names the lock: ${error.message}`);
    ok(existsSync(lock), "a live writer's lock is never removed");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a 0-byte lock written inside the staleness window is left in place", async () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    let error;
    try { await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git: gitRun }); }
    catch (e) { error = e; }
    ok(error, "a young lock refuses the clear");
    ok(error.message.includes(lock), error.message);
    ok(existsSync(lock), "a lock whose mtime moved within the window is never removed");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a lock on another branch is left untouched", async () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const other = lockPathFor(repo, "swarm/other");
    mkdirSync(resolve(other, ".."), { recursive: true });
    writeFileSync(other, "");
    await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git: gitRun });
    ok(existsSync(other), "another task's branch lock is none of this task's business");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a lock on a manifest-declared branch is left in place and named", async () => {
  const repo = initRepo();
  const dir = scratch();
  try {
    const lock = lockPathFor(repo, "feature/shared");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    ageLock(lock, STALE_AFTER_MS + 5000);
    let error;
    try { await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "feature/shared", branchDerived: false, existedBefore: false, git: gitRun }); }
    catch (e) { error = e; }
    ok(error, "a declared branch's lock is not this task's alone");
    ok(error.message.includes(lock), error.message);
    ok(existsSync(lock), "the declared branch's lock survives");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a registered, locked half-made tree is removed", async () => {
  const repo = initRepo();
  const dir = scratch();
  const tree = join(dir, "tree");
  try {
    git(["worktree", "add", "-b", "swarm/locked", tree, "--no-track", "HEAD"], repo);
    git(["worktree", "lock", tree], repo);
    await clearTaskDebris({ repo, path: tree, branch: "swarm/locked", branchDerived: true, existedBefore: true, git: gitRun });
    ok(!existsSync(tree), "only -f -f can remove a locked tree, and it must go");
    ok(!git(["worktree", "list", "--porcelain"], repo).includes("swarm/locked"), "its registration is gone too");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("an unregistered directory created by this attempt is removed", async () => {
  const repo = initRepo();
  const dir = scratch();
  const leftover = join(dir, "half");
  try {
    mkdirSync(leftover);
    writeFileSync(join(leftover, "partial.txt"), "half-checked-out\n");
    await clearTaskDebris({ repo, path: leftover, branch: "swarm/half", branchDerived: true, existedBefore: false, git: gitRun });
    ok(!existsSync(leftover), "the attempt's own half-made directory is debris");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a directory that existed before the attempt is not removed", async () => {
  const repo = initRepo();
  const dir = scratch();
  const held = join(dir, "mine");
  try {
    mkdirSync(held);
    writeFileSync(join(held, "notes.txt"), "user data\n");
    let error;
    try { await clearTaskDebris({ repo, path: held, branch: "swarm/mine", branchDerived: true, existedBefore: true, git: gitRun }); }
    catch (e) { error = e; }
    ok(error, "the clear refuses a directory it did not create");
    ok(error.message.includes(held), error.message);
    ok(existsSync(join(held, "notes.txt")), "user data is never deleted");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a branch carrying unlanded commits is never deleted or reset by the clear", async () => {
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

    await clearTaskDebris({ repo, path: tree, branch: "swarm/keep", branchDerived: true, existedBefore: false, git: gitRun });
    equal(git(["rev-parse", "swarm/keep"], repo), tip, "the branch and its commit survive the clear");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

// Two reads taken back to back agree on anything, so the lock has to be WATCHED for the
// whole window before it can be called dead.
test("an old 0-byte lock is watched for the whole window before it is removed", { timeout: 30000 }, async () => {
  const repo = initRepo();
  const dir = scratch();
  const window = 4000;
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    ageLock(lock, 5000);
    const started = Date.now();
    await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git: gitRun, lockWindowMs: window });
    ok(!existsSync(lock), "the dead lock was removed");
    ok(Date.now() - started >= window, `the lock was observed for its window: ${Date.now() - started}ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

test("a lock still being written during the window is left in place", { timeout: 20000 }, async () => {
  const repo = initRepo();
  const dir = scratch();
  const window = 800;
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    ageLock(lock, 5000);
    const writing = setTimeout(() => writeFileSync(lock, "0123\n"), Math.round(window / 2));
    let error;
    try { await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git: gitRun, lockWindowMs: window }); }
    catch (e) { error = e; }
    clearTimeout(writing);
    ok(error, "a lock that changed mid-window refuses the clear");
    ok(/changed while it was checked/.test(error.message), error.message);
    ok(existsSync(lock), "the writer's lock survives");
  } finally { rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

// A 60-second synchronous git call in a retry path freezes every other leaf's
// callbacks for as long as it blocks.
test("the debris clear yields to the event loop while git runs", { timeout: 20000 }, async () => {
  const repo = initRepo();
  const dir = scratch();
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 40);
  const slowGit = (args, cwd) => new Promise((resume) => setTimeout(() => resume(gitRun(args, cwd)), 150));
  try {
    const started = Date.now();
    await clearTaskDebris({ repo, path: join(dir, "tree"), branch: "swarm/mine", branchDerived: true, existedBefore: false, git: slowGit });
    ok(ticked, "a pending timer ran while the clear's git call was outstanding");
    ok(Date.now() - started >= 400, `every git call was awaited: ${Date.now() - started}ms`);
  } finally { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); cleanup(repo); }
});

// ---- the timeout message names a hook only when the repo has one

test("with no hooks the timeout names contention, not a hook", async () => {
  const repo = initRepo();
  try {
    git(["config", "core.hooksPath", join(repo, ".git", "hooks")], repo);
    const message = await timeoutMessage({ repo, task: { id: "t" }, attempts: 3, timeoutMs: 720000, git: gitRun });
    ok(/timed out for 't' after 3 attempts, the last with a 720s budget/.test(message), message);
    ok(/contention|large object store/.test(message), message);
    ok(!/post-checkout|reference-transaction/.test(message), `no hook is named: ${message}`);
    equal(await slowHook(repo, { git: gitRun }), null, "only *.sample files are present");
  } finally { cleanup(repo); }
});

test("a hook with no execute bits is still detected", async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  try {
    writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\n", { mode: 0o644 });
    git(["config", "core.hooksPath", hooks], repo);
    equal(await slowHook(repo, { git: gitRun }), "post-checkout", "presence, not an execute bit, is the test");
  } finally { removeEventually(hooks); cleanup(repo); }
});

test("a hook in a linked worktree's common dir is detected", async () => {
  const repo = initRepo();
  const dir = scratch();
  const linked = join(dir, "linked");
  try {
    const common = resolve(repo, git(["rev-parse", "--git-common-dir"], repo));
    mkdirSync(join(common, "hooks"), { recursive: true });
    writeFileSync(join(common, "hooks", "reference-transaction"), "#!/bin/sh\n", { mode: 0o644 });
    git(["worktree", "add", linked, "-b", "linked", "--no-track", "HEAD"], repo);
    equal(await slowHook(linked, { git: gitRun }), "reference-transaction", "the common dir's hooks are the worktree's hooks");
  } finally { removeEventually(dir); cleanup(repo); }
});

test("a reference-transaction hook is named in the timeout", async () => {
  const repo = initRepo();
  const hooks = hooksDir();
  try {
    writeFileSync(join(hooks, "reference-transaction"), "#!/bin/sh\n", { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], repo);
    const message = await timeoutMessage({ repo, task: { id: "t" }, attempts: 3, timeoutMs: 720000, git: gitRun });
    ok(/reference-transaction/.test(message), message);
  } finally { removeEventually(hooks); cleanup(repo); }
});

// ---- argument validation

test("prepareIsolation requires addTimeoutMs and names it in the error", async () => {
  for (const opts of [undefined, {}, { addTimeoutMs: 0 }, { addTimeoutMs: "5" }]) {
    let error;
    try { await prepareIsolation({ id: "x", originalCwd: "." }, CFG, ".", opts); } catch (e) { error = e; }
    ok(error, `throws for ${JSON.stringify(opts)}`);
    ok(/addTimeoutMs/.test(error.message), error.message);
  }
});

