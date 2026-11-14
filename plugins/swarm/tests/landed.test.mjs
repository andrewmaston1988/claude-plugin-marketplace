import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { unlandedCount, absorbedAt } from "../src/landed.mjs";
import { prepareIsolation, collect, treeDirFor, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { blockers } from "../src/prune.mjs";
import { initRepo, commitAll, cleanup, dropWorktree } from "./helpers/worktree-fixtures.mjs";

const PREFIX = "swarm/";

function git(args, cwd, opts = {}) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, input: opts.input });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function must(args, cwd) {
  const r = git(args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function tmpRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-landed-"));
  must(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  must(["add", "."], repo);
  must(["commit", "-qm", "init"], repo);
  return repo;
}

function newBranch(repo, name, from = "main") {
  must(["checkout", "-q", "-b", name, from], repo);
}

function checkout(repo, name) {
  must(["checkout", "-q", name], repo);
}

function writeCommit(repo, file, content, msg) {
  writeFileSync(join(repo, file), content);
  must(["add", "."], repo);
  must(["commit", "-qm", msg], repo);
}

// A bare origin at <repo>'s side, pushed and with origin/HEAD set.
function addOrigin(repo) {
  const bare = mkdtempSync(join(tmpdir(), "swarm-landed-origin-"));
  must(["init", "-q", "--bare"], bare);
  must(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
  must(["remote", "add", "origin", bare], repo);
  must(["push", "-q", "-u", "origin", "main"], repo);
  must(["remote", "set-head", "origin", "main"], repo);
  return bare;
}

// One repo per row, cleaned even when an assertion throws.
function withRepo(fn) {
  const repo = tmpRepo();
  try { return fn(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
}

function withRepoAndOrigin(fn) {
  const repo = tmpRepo();
  const bare = addOrigin(repo);
  try { return fn(repo); } finally { cleanup(repo, bare); }
}

function landed(repo, branch, gitRunner = git) {
  return unlandedCount(branch, repo, { prefix: PREFIX, gitRunner });
}

function recording(gitRunner = git) {
  const calls = [];
  return {
    calls,
    run: (args, cwd, opts) => { calls.push(args); return gitRunner(args, cwd, opts); },
  };
}

test("row 1: a leaf merged into feat is landed while the main checkout sits on other", () => withRepo((repo) => {
  newBranch(repo, "other");
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  newBranch(repo, "feat", "main");
  must(["merge", "-q", "--ff-only", "swarm/leaf"], repo);
  checkout(repo, "other");

  equal(landed(repo, "swarm/leaf"), 0);
}));

test("row 2: reachability through origin/feat alone counts as landed", () => withRepoAndOrigin((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  newBranch(repo, "feat", "main");
  must(["merge", "-q", "--ff-only", "swarm/leaf"], repo);
  must(["push", "-q", "origin", "feat"], repo);
  checkout(repo, "main");
  must(["branch", "-q", "-D", "feat"], repo);

  equal(landed(repo, "swarm/leaf"), 0);
}));

test("row 3: a remote squash counts as landed through origin/HEAD with no local default branch", () => withRepoAndOrigin((repo) => {
  newBranch(repo, "other");
  checkout(repo, "main");
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf one\n", "leaf one");
  writeCommit(repo, "b.txt", "leaf two\n", "leaf two");
  checkout(repo, "main");
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash leaf"], repo);
  must(["push", "-q", "origin", "main"], repo);
  checkout(repo, "other");
  must(["branch", "-q", "-D", "main"], repo);

  equal(must(["branch", "--list", "main"], repo), "", "precondition: no local default branch");
  equal(landed(repo, "swarm/leaf"), 0);
}));

test("row 3a: the local twin absorbs when origin/HEAD names a remote ref that is behind", () => withRepoAndOrigin((repo) => {
  newBranch(repo, "other");
  checkout(repo, "main");
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf one\n", "leaf one");
  writeCommit(repo, "b.txt", "leaf two\n", "leaf two");
  checkout(repo, "main");
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash leaf"], repo);
  checkout(repo, "other");

  equal(landed(repo, "swarm/leaf"), 0);
}));

test("row 4: traditional merge, squash and rebase-and-merge all count 0", () => {
  const land = (kind) => withRepo((repo) => {
    newBranch(repo, "swarm/leaf", "main");
    writeCommit(repo, "a.txt", "leaf one\n", "leaf one");
    writeCommit(repo, "b.txt", "leaf two\n", "leaf two");
    checkout(repo, "main");
    if (kind === "merge") must(["merge", "-q", "--no-ff", "-m", "merge leaf", "swarm/leaf"], repo);
    if (kind === "squash") { must(["merge", "-q", "--squash", "swarm/leaf"], repo); must(["commit", "-qm", "squash leaf"], repo); }
    if (kind === "rebase") {
      writeCommit(repo, "c.txt", "main moved\n", "main moved");
      must(["rebase", "-q", "main", "swarm/leaf"], repo);
      checkout(repo, "main");
      must(["merge", "-q", "--ff-only", "swarm/leaf"], repo);
    }
    return landed(repo, "swarm/leaf");
  });
  for (const kind of ["merge", "squash", "rebase"]) equal(land(kind), 0, kind);
});

test("row 5: a later edit on the default branch does not un-land the squash", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf a\n", "leaf a");
  writeCommit(repo, "b.txt", "leaf b\n", "leaf b");
  checkout(repo, "main");
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash leaf"], repo);
  const squash = must(["rev-parse", "HEAD"], repo);
  writeCommit(repo, "a.txt", "later a\n", "later edit");

  const rec = recording();
  equal(unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: rec.run }), 0);
  ok(rec.calls.some((args) => args[0] === "merge-tree" && args[2] === squash),
    "the squash commit itself must be one of the scanned bases");
}));

test("row 6: a leaf commit on its own branch alone is unlanded and blocks prune", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  checkout(repo, "main");

  const n = landed(repo, "swarm/leaf");
  ok(Number.isFinite(n) && n >= 1, `expected a finite count of at least 1, got ${n}`);
  equal(blockers([{ path: "/tree", branch: "swarm/leaf", unlanded: n, dirty: 0 }]).length, 1);
}));

test("row 7a: another swarm branch is not a landing place", () => withRepo((repo) => {
  newBranch(repo, "swarm/a", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  newBranch(repo, "swarm/b", "swarm/a");
  checkout(repo, "main");

  ok(landed(repo, "swarm/a") >= 1);
}));

test("row 7b: origin/swarm/... is not a landing place", () => withRepoAndOrigin((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  must(["push", "-q", "origin", "swarm/leaf"], repo);
  checkout(repo, "main");

  ok(landed(repo, "swarm/leaf") >= 1);
}));

test("row 7c: a main checkout on a swarm branch is not a candidate base", () => withRepo((repo) => {
  newBranch(repo, "swarm/a", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  newBranch(repo, "swarm/b", "swarm/a");

  ok(landed(repo, "swarm/a") !== 0, "a swarm branch must never answer landed");
}));

test("row 8a: absorbing only the leaf's first commit is not landed", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf a\n", "leaf a");
  const first = must(["rev-parse", "HEAD"], repo);
  writeCommit(repo, "b.txt", "leaf b\n", "leaf b");
  checkout(repo, "main");
  must(["cherry-pick", "-n", first], repo);
  must(["commit", "-qm", "part of leaf"], repo);

  ok(landed(repo, "swarm/leaf") >= 1);
}));

test("row 8b: a PR branch that reaches the leaf answers landed until it is deleted", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf a\n", "leaf a");
  writeCommit(repo, "b.txt", "leaf b\n", "leaf b");
  newBranch(repo, "feat", "swarm/leaf");
  writeCommit(repo, "b.txt", "review fix\n", "review fix");
  checkout(repo, "main");
  must(["merge", "-q", "--squash", "feat"], repo);
  must(["commit", "-qm", "squash pr"], repo);

  equal(landed(repo, "swarm/leaf"), 0, "the PR branch still reaches the leaf");
  must(["branch", "-q", "-D", "feat"], repo);
  ok(landed(repo, "swarm/leaf") >= 1, "the review fix means the squash absorbed nothing");
}));

test("row 9a: a conflicting merge-tree moves on and returns the cherry count", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf\n", "leaf");
  checkout(repo, "main");
  writeCommit(repo, "a.txt", "main\n", "main edit");

  equal(landed(repo, "swarm/leaf"), 1, "a merge-tree conflict at every touching commit is a definite no");
}));

test("row 9b: a merge-tree failing any other way, or an unresolvable branch, is Infinity", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
  checkout(repo, "main");

  const poisoned = (args, cwd, opts) =>
    args[0] === "merge-tree" ? { status: 2, stdout: "", stderr: "boom" } : git(args, cwd, opts);
  equal(unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: poisoned }), Infinity);
  equal(landed(repo, "swarm/missing"), Infinity);
}));

test("row 10: a merge=ours path cannot fake absorption", () => withRepo((repo) => {
  writeCommit(repo, ".gitattributes", "*.txt merge=ours\n", "attrs");
  must(["config", "merge.ours.driver", "true"], repo);
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf\n", "leaf work");
  checkout(repo, "main");
  writeCommit(repo, "a.txt", "main\n", "conflicting edit");

  equal(absorbedAt(must(["rev-parse", "HEAD"], repo), "swarm/leaf", repo, git), true,
    "precondition: merge-tree alone takes the base's side and equals its tree");
  equal(landed(repo, "swarm/leaf"), 1);
}));

test("row 11: cost is bounded and the cap reports unlanded, never 0", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  writeCommit(repo, "a.txt", "leaf\n", "leaf work");
  const leaf = must(["rev-parse", "HEAD"], repo);
  checkout(repo, "main");
  must(["cherry-pick", "-n", leaf], repo);
  must(["commit", "-qm", "squash leaf"], repo);
  for (let i = 0; i < 24; i += 1) writeCommit(repo, "a.txt", `later ${i}\n`, `later ${i}`);

  const rec = recording();
  const n = unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: rec.run });
  ok(n >= 1, `the absorbing squash sits past the 20-commit scan cap, so this is unlanded: ${n}`);
  equal(rec.calls.filter((args) => args[0] === "for-each-ref").length, 1);
  ok(rec.calls.filter((args) => args[0] === "merge-base").length <= 3, "at most three candidate bases");
  equal(rec.calls.filter((args) => args[0] === "merge-tree").length, 21, "the tip plus at most 20 touching commits");
}));

test("row 16: below git 2.38 absorption is skipped, so an old git reports the cherry count, not Infinity", () => {
  const calls = [];
  const oldGit = (args, cwd, opts) => {
    calls.push(args);
    if (args[0] === "version") return { status: 0, stdout: "git version 2.34.1", stderr: "" };
    if (args[0] === "merge-tree") return { status: 129, stdout: "", stderr: "error: unknown option `write-tree'" };
    return git(args, cwd, opts);
  };

  withRepo((repo) => {
    newBranch(repo, "swarm/leaf", "main");
    writeCommit(repo, "a.txt", "leaf one\n", "leaf one");
    writeCommit(repo, "b.txt", "leaf two\n", "leaf two");
    checkout(repo, "main");
    must(["merge", "-q", "--squash", "swarm/leaf"], repo);
    must(["commit", "-qm", "squash leaf"], repo);

    const n = unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: oldGit });
    ok(Number.isFinite(n) && n >= 1, `an old git answers with the cherry count, never Infinity: ${n}`);
    equal(calls.filter((args) => args[0] === "merge-tree").length, 0, "merge-tree must not be attempted below the floor");
  });

  withRepo((repo) => {
    newBranch(repo, "other");
    newBranch(repo, "swarm/leaf", "main");
    writeCommit(repo, "leaf.txt", "leaf work\n", "leaf work");
    newBranch(repo, "feat", "main");
    must(["merge", "-q", "--ff-only", "swarm/leaf"], repo);
    checkout(repo, "other");

    equal(unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: oldGit }), 0, "reachability needs no merge-tree");
  });
});

test("row 17: a branch touching 1,000 files measures landed, and no git argv nears the platform limit", () => withRepo((repo) => {
  newBranch(repo, "swarm/leaf", "main");
  mkdirSync(join(repo, "a"), { recursive: true });
  // Long enough that the 1,000 names do not fit on a Windows command line.
  const name = (i) => `a/${String(i).padStart(4, "0")}-a-name-long-enough-to-overflow-a-command-line.txt`;
  for (let i = 1; i <= 1000; i += 1) {
    writeFileSync(join(repo, name(i)), `file ${i}\n`);
  }
  must(["add", "."], repo);
  must(["commit", "-qm", "a thousand files"], repo);
  checkout(repo, "main");
  must(["merge", "-q", "--squash", "swarm/leaf"], repo);
  must(["commit", "-qm", "squash a thousand files"], repo);
  // A later edit moves the tip off the squash, so the touching-commit scan runs with
  // the full path list in play.
  writeCommit(repo, name(500), "later\n", "later edit");

  const rec = recording();
  const n = unlandedCount("swarm/leaf", repo, { prefix: PREFIX, gitRunner: rec.run });
  equal(n, 0);
  const longest = Math.max(...rec.calls.map((args) => args.join(" ").length));
  ok(longest < 30000, `a path list on argv overflows a Windows command line: ${longest} chars`);
  ok(rec.calls.some((args) => args[0] === "check-attr" && args.includes("--stdin")), "the path list travels on stdin");
}));

test("row 12: collect destroys a tree whose branch the squash absorbed, and keeps one it did not", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-landed-res-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "swarm-landed-trees-"));
  const cfg = { ...{ provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] }, resultInlineCap: 4000, worktreeBranchPrefix: PREFIX }, treeRoot };
  const add = () => ({ addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: must(["rev-parse", "HEAD"], repo) });
  try {
    const p1 = { id: "p1", worktreeName: "absorbed", originalCwd: repo, cwd: repo };
    const wt1 = prepareIsolation(p1, cfg, results, add());
    writeFileSync(join(wt1.path, "feat.txt"), "phase 1\n");
    commitAll(wt1.path, "phase 1");
    writeFileSync(join(repo, "feat.txt"), "phase 1\n");
    commitAll(repo, "squash phase 1");
    const p2 = { id: "p2", worktreeName: "absorbed", originalCwd: repo, cwd: repo };
    const wt2 = prepareIsolation(p2, cfg, results, add());
    const swept = collect(p2, cfg, wt2);
    equal(swept.kept, false, "an absorbed branch is destroyed with its tree");
    ok(!existsSync(wt2.path));
    ok(!must(["branch", "--list", "swarm/absorbed"], repo).includes("swarm/absorbed"));

    const p3 = { id: "p3", worktreeName: "carried", originalCwd: repo, cwd: repo };
    const wt3 = prepareIsolation(p3, cfg, results, add());
    writeFileSync(join(wt3.path, "carried.txt"), "unlanded\n");
    commitAll(wt3.path, "unlanded work");
    const p4 = { id: "p4", worktreeName: "carried", originalCwd: repo, cwd: repo };
    const wt4 = prepareIsolation(p4, cfg, results, add());
    const kept = collect(p4, cfg, wt4);
    equal(kept.kept, true, "a branch carrying unlanded work is kept");
    ok(existsSync(wt4.path));
    ok(must(["branch", "--list", "swarm/carried"], repo).includes("swarm/carried"));
    dropWorktree(repo, treeDirFor(results, "carried", cfg));
  } finally { cleanup(results, treeRoot, repo); }
});

test("row 12: the stale reset refuses unabsorbed work and reuses an absorbed branch", () => {
  const repo = initRepo();
  const results = mkdtempSync(join(tmpdir(), "swarm-landed-reset-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "swarm-landed-trees-"));
  const cfg = { provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] }, resultInlineCap: 4000, worktreeBranchPrefix: PREFIX, treeRoot };
  const add = () => ({ addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: must(["rev-parse", "HEAD"], repo) });
  try {
    const stale = prepareIsolation({ id: "s1", worktreeName: "sq", originalCwd: repo }, cfg, results, add());
    writeFileSync(join(stale.path, "sq.txt"), "squashed work\n");
    commitAll(stale.path, "sq work");
    dropWorktree(repo, stale.path);

    let refused;
    try { prepareIsolation({ id: "s2", worktreeName: "sq", originalCwd: repo }, cfg, results, add()); }
    catch (e) { refused = e; }
    ok(refused && /unlanded commit/.test(refused.message), `unabsorbed work must refuse the reset: ${refused?.message}`);

    writeFileSync(join(repo, "sq.txt"), "squashed work\n");
    commitAll(repo, "squashed sq");
    const reused = prepareIsolation({ id: "s3", worktreeName: "sq", originalCwd: repo }, cfg, results, add());
    ok(existsSync(reused.path), "a squash-absorbed branch is reusable");
    dropWorktree(repo, treeDirFor(results, "sq", cfg));
  } finally { cleanup(results, treeRoot, repo); }
});
