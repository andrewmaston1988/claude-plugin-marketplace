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

test("plan: a kept tree becomes a row with path, branch, measured bytes and repo", () => {
  const git = () => ({ status: 1, stdout: "", stderr: "" });
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/results/wt-impl",
    readdirSync: (p) => (p === "/results/wt-impl" ? [{ name: "a.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 1024 }),
  };
  const run = { repo: "/repo", resultsDir: "/results", worktreesKept: [{ branch: "swarm/impl", path: "/results/wt-impl" }] };
  const { rows } = plan(run, git, fs);
  deepEqual(rows, [{ path: "/results/wt-impl", branch: "swarm/impl", bytes: 1024, repo: "/repo" }]);
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
    return { status: 1, stdout: "", stderr: "" };
  };
  const orphanPath = resolve("/results/wt-orphan");
  const fs = {
    existsSync: (p) => p === "/repo" || p === orphanPath,
    readdirSync: (p) => (p === orphanPath ? [{ name: "x.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 7 }),
  };
  const run = { repo: "/repo", resultsDir: "/results", worktreesKept: [] };
  const { rows } = plan(run, git, fs);
  equal(rows.length, 1);
  equal(rows[0].path, orphanPath);
  equal(rows[0].branch, "swarm/orphan");
  equal(rows[0].bytes, 7);
  equal(rows[0].repo, "/repo");
});

test("plan: a repo that no longer exists is never asked for its orphaned worktrees", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 1, stdout: "", stderr: "" }; };
  const fs = {
    existsSync: (p) => p === "/results/wt-gone",
    readdirSync: (p) => (p === "/results/wt-gone" ? [{ name: "a.txt", isDirectory: () => false }] : []),
    statSync: () => ({ size: 512 }),
  };
  const run = { repo: "/gone-repo", resultsDir: "/results", worktreesKept: [{ branch: "swarm/gone", path: "/results/wt-gone" }] };
  const { rows } = plan(run, git, fs);
  deepEqual(rows, [{ path: "/results/wt-gone", branch: "swarm/gone", bytes: 512, repo: "/gone-repo" }]);
  equal(calls.length, 0, "must not run git against a repo that doesn't exist");
});

test("execute: worktree remove --force then branch -D, in that order; a repo-missing row is rm -rf'd with no git at all", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  const rmCalls = [];
  const fs = { existsSync: (p) => p !== "/gone", rmSync: (p, opts) => rmCalls.push({ p, opts }) };
  const rows = [
    { path: "/r/wt-a", branch: "swarm/a", bytes: 10, repo: "/repo" },
    { path: "/r/wt-gone", branch: "swarm/gone", bytes: 5, repo: "/gone" },
  ];
  execute(rows, git, fs);
  deepEqual(calls, [
    { args: ["worktree", "remove", "--force", "/r/wt-a"], cwd: "/repo" },
    { args: ["branch", "-D", "swarm/a"], cwd: "/repo" },
  ]);
  equal(rmCalls.length, 1);
  equal(rmCalls[0].p, "/r/wt-gone");
});

test("execute never rm's anything outside the rows it was given — run.log, summary.json, results/, digest.md, report.md, manifest.json survive", () => {
  const git = () => ({ status: 0, stdout: "", stderr: "" });
  const rmCalls = [];
  const fs = {
    existsSync: (p) => p !== "/gone",
    rmSync: (p) => rmCalls.push(p),
  };
  const rows = [
    { path: "/run/wt-a", branch: "swarm/a", bytes: 10, repo: "/repo" },
    { path: "/run/wt-gone", branch: "swarm/gone", bytes: 5, repo: "/gone" },
  ];
  execute(rows, git, fs);
  deepEqual(rmCalls, ["/run/wt-gone"], "rmSync must be called only for the repo-missing row's own worktree path");
  const forbidden = ["/run/run.log", "/run/summary.json", "/run/results", "/run/digest.md", "/run/report.md", "/run/manifest.json"];
  for (const f of forbidden) ok(!rmCalls.includes(f), `execute must never rm ${f}`);
});

test("formatPrune: one line per row with size, then the freed/would-free closing line", () => {
  const rows = [
    { path: "/r/wt-a", branch: "swarm/a", bytes: 1073741824, repo: "/repo" },
    { path: "/r/wt-b", branch: "swarm/b", bytes: 536870912, repo: "/repo" },
  ];
  const real = formatPrune(rows, { dryRun: false });
  ok(real.includes("/r/wt-a"), real);
  ok(real.includes("swarm/a"), real);
  ok(real.includes("/r/wt-b"), real);
  ok(real.includes("swarm/b"), real);
  ok(/freed 1\.50 GB across 2 worktrees/.test(real), real);

  const dry = formatPrune(rows, { dryRun: true });
  ok(/would free 1\.50 GB across 2 worktrees/.test(dry), dry);
});
