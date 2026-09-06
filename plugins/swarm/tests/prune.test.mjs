import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { resolve } from "node:path";
import { plan, execute, formatPrune } from "../src/prune.mjs";

test("plan: a live run short-circuits before any git call", () => {
  let gitCalled = false;
  const git = () => { gitCalled = true; return { status: 0, stdout: "", stderr: "" }; };
  const fs = { existsSync: () => true, readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const result = plan({ live: true }, git, fs);
  deepEqual(result, { live: true });
  equal(gitCalled, false, "git must never be consulted when the run is live");
});

test("plan: a kept tree whose branch is an ancestor of the default branch reads as merged", () => {
  const git = (args) => {
    if (args[0] === "merge-base") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-impl",
    readdirSync: (p) => (p === "/results/wt-impl" ? [{ name: "a.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 1024 }),
  };
  const run = { repo: "/repo", base: "main", resultsDir: "/results", worktreesKept: [{ branch: "swarm/impl", path: "/results/wt-impl" }] };
  const { rows } = plan(run, git, fs);
  equal(rows.length, 1);
  equal(rows[0].state, "merged");
  equal(rows[0].branch, "swarm/impl");
  equal(rows[0].path, "/results/wt-impl");
  equal(rows[0].bytes, 1024);
});

test("plan: a squash-landed branch (cherry all '-') reads as merged", () => {
  const git = (args) => {
    if (args[0] === "merge-base") return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "cherry") return { status: 0, stdout: "- aaa111\n- bbb222", stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-sq",
    readdirSync: (p) => (p === "/results/wt-sq" ? [{ name: "a.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 100 }),
  };
  const run = { repo: "/repo", base: "main", resultsDir: "/results", worktreesKept: [{ branch: "swarm/sq", path: "/results/wt-sq" }] };
  const { rows } = plan(run, git, fs);
  equal(rows[0].state, "merged");
});

test("plan: a branch 2 commits ahead reads as unlanded, with the count", () => {
  const git = (args) => {
    if (args[0] === "merge-base") return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "cherry") return { status: 0, stdout: "+ ccc333\n+ ddd444", stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-ahead",
    readdirSync: (p) => (p === "/results/wt-ahead" ? [{ name: "a.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 50 }),
  };
  const run = { repo: "/repo", base: "main", resultsDir: "/results", worktreesKept: [{ branch: "swarm/ahead", path: "/results/wt-ahead" }] };
  const { rows } = plan(run, git, fs);
  equal(rows[0].state, "unlanded (2 commits ahead)");
});

test("plan: non-empty porcelain status reads as dirty regardless of landing state", () => {
  const git = (args) => {
    if (args[0] === "status") return { status: 0, stdout: " M file.txt", stderr: "" };
    if (args[0] === "merge-base") return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "cherry") return { status: 0, stdout: "+ ccc333", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-d",
    readdirSync: (p) => (p === "/results/wt-d" ? [{ name: "file.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 42 }),
  };
  const run = { repo: "/repo", base: "main", resultsDir: "/results", worktreesKept: [{ branch: "swarm/d", path: "/results/wt-d" }] };
  const { rows } = plan(run, git, fs);
  equal(rows[0].state, "dirty");
});

test("plan: a tree registered in git under resultsDir but absent from worktreesKept is still found", () => {
  const git = (args) => {
    if (args[0] === "worktree") {
      return {
        status: 0,
        stdout: [
          "worktree /repo",
          "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "branch refs/heads/main",
          "",
          "worktree /results/wt-orphan",
          "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "branch refs/heads/swarm/orphan",
        ].join("\n"),
        stderr: "",
      };
    }
    if (args[0] === "merge-base") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-orphan",
    readdirSync: (p) => (p === "/results/wt-orphan" ? [{ name: "x.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 7 }),
  };
  const run = { repo: "/repo", base: "main", resultsDir: "/results", worktreesKept: [] };
  const { rows } = plan(run, git, fs);
  equal(rows.length, 1);
  equal(rows[0].path, resolve("/results/wt-orphan"));
  equal(rows[0].branch, "swarm/orphan");
  equal(rows[0].state, "merged");
});

test("plan: a kept tree whose repo no longer exists reads as repo missing, untouched by git", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 1, stdout: "", stderr: "" }; };
  const fs = {
    existsSync: (p) => p === "/results/wt-gone",
    readdirSync: (p) => (p === "/results/wt-gone" ? [{ name: "a.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 512 }),
  };
  const run = { repo: "/gone-repo", base: "main", resultsDir: "/results", worktreesKept: [{ branch: "swarm/gone", path: "/results/wt-gone" }] };
  const { rows } = plan(run, git, fs);
  equal(rows.length, 1);
  equal(rows[0].state, "repo missing");
  ok(!calls.some((c) => c.cwd === "/gone-repo"), "must not run git against a repo that doesn't exist");
});

test("execute: worktree remove --force then branch -D, in that order; a repo-missing row is rm -rf'd with no git at all", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  const rmCalls = [];
  const fs = { rmSync: (p, opts) => rmCalls.push({ p, opts }) };
  const rows = [
    { path: "/r/wt-a", branch: "swarm/a", bytes: 10, state: "merged", repo: "/repo" },
    { path: "/r/wt-gone", branch: "swarm/gone", bytes: 5, state: "repo missing", repo: "/gone" },
  ];
  execute(rows, git, fs);
  deepEqual(calls, [
    { args: ["worktree", "remove", "--force", "/r/wt-a"], cwd: "/repo" },
    { args: ["branch", "-D", "swarm/a"], cwd: "/repo" },
  ]);
  equal(rmCalls.length, 1);
  equal(rmCalls[0].p, "/r/wt-gone");
});

test("formatPrune: one line per row with size + state, then the freed/would-free closing line", () => {
  const rows = [
    { path: "/r/wt-a", branch: "swarm/a", bytes: 1073741824, state: "merged", repo: "/repo" },
    { path: "/r/wt-b", branch: "swarm/b", bytes: 536870912, state: "dirty", repo: "/repo" },
  ];
  const real = formatPrune(rows, { dryRun: false });
  ok(real.includes("/r/wt-a"), real);
  ok(real.includes("merged"), real);
  ok(real.includes("/r/wt-b"), real);
  ok(real.includes("dirty"), real);
  ok(/freed 1\.50 GB across 2 worktrees/.test(real), real);

  const dry = formatPrune(rows, { dryRun: true });
  ok(/would free 1\.50 GB across 2 worktrees/.test(dry), dry);
});
