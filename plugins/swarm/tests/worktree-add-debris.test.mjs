import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearTaskDebris } from "../src/worktree-add.mjs";
import { STALE_AFTER_MS } from "../src/stale-lock.mjs";
import { initRepo, cleanup, git } from "./helpers/worktree-fixtures.mjs";
import { ageLock, gitRun, lockPathFor, scratch } from "./helpers/worktree-add-fixtures.mjs";

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
test("an old 0-byte lock is watched for the whole window before it is removed", { timeout: 60000 }, async () => {
  const repo = initRepo();
  const dir = scratch();
  // Well above the few seconds the clear's own git calls cost, so the window is what
  // the elapsed time measures.
  const window = 20000;
  try {
    const lock = lockPathFor(repo, "swarm/mine");
    mkdirSync(resolve(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    ageLock(lock, window + 2000);
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
