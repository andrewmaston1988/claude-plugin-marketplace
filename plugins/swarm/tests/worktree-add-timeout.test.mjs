import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareIsolation, treeDirFor } from "../src/worktree.mjs";
import { addWorktree, gitRunAsync, slowHook, timeoutMessage } from "../src/worktree-add.mjs";
import { initRepo, cleanup, git, CFG } from "./helpers/worktree-fixtures.mjs";
import { ageLock, gitRun, lockPathFor, scratch } from "./helpers/worktree-add-fixtures.mjs";

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

