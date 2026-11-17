import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { plan, execute, formatPrune, blockers } from "../src/prune.mjs";
import { prepareIsolation, runScopeKey, WORKTREE_ADD_TIMEOUT_MS } from "../src/worktree.mjs";
import { runCliInProcess } from "./helpers/cli.mjs";
import { commitAll, gitOut } from "./helpers/cli-fixture.mjs";
import { dropSnapPrune, pruneFixture, writeFinishedRun } from "./helpers/prune-fixture.mjs";

test("plan: a live run short-circuits before any git call", () => {
  let gitCalled = false;
  const git = () => { gitCalled = true; return { status: 0, stdout: "", stderr: "" }; };
  const fs = { existsSync: () => true, readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const result = plan({ live: true }, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
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
  const run = { repos: ["/repo"], resultsDir: "/results", worktreesKept: [{ branch: "swarm/impl", path: "/results/wt-impl", repo: "/repo" }] };
  const { rows } = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  deepEqual(rows, [{ path: "/results/wt-impl", branch: "swarm/impl", bytes: 1024, repo: "/repo", unlanded: Infinity, dirty: Infinity }]);
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
  const run = { repos: ["/repo"], resultsDir: "/results", worktreesKept: [] };
  const { rows } = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
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
  const run = { repos: ["/gone-repo"], resultsDir: "/results", worktreesKept: [{ branch: "swarm/gone", path: "/results/wt-gone", repo: "/gone-repo" }] };
  const { rows } = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  deepEqual(rows, [{ path: "/results/wt-gone", branch: "swarm/gone", bytes: 512, repo: "/gone-repo", unlanded: Infinity, dirty: Infinity }]);
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

test("execute: a branchless snapshot row is removed with -f -f and never gets a branch -D", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  const fs = { existsSync: () => true, rmSync: () => {} };
  execute([{ path: "/r/wt-snapshot-abc", branch: null, bytes: 1, repo: "/repo" }], git, fs);
  deepEqual(calls, [{ args: ["worktree", "remove", "-f", "-f", "/r/wt-snapshot-abc"], cwd: "/repo" }]);
});

test("formatPrune labels a branchless row", () => {
  const out = formatPrune([{ path: "/r/wt-a", branch: null, repo: "/repo", bytes: 0 }]);
  ok(/wt-a/.test(out), out);
  ok(out.includes("(detached)") && !/snapshot/.test(out), out);
});

test("plan measures unlanded commits and dirty porcelain; blockers include unknown measurements", () => {
  const calls = [];
  // Not reachable, and the tip adds a file the base lacks — so the landed check
  // falls through to the cherry count. Without these answers every command fails
  // and the row measures Infinity.
  const git = (args, cwd) => {
    calls.push({ args, cwd });
    // 2.38 answers the single `--write-tree` call below; 2.39 would take the batch
    // path, whose NUL-framed stdin protocol this fake does not speak.
    if (args[0] === "version") return { status: 0, stdout: "git version 2.38.0", stderr: "" };
    if (args[0] === "for-each-ref") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "symbolic-ref") {
      return args[1] === "-q" ? { status: 0, stdout: "refs/heads/main", stderr: "" } : { status: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return args[1] === "--verify"
        ? { status: 0, stdout: "base-sha", stderr: "" }
        : { status: 0, stdout: "base-tree", stderr: "" };
    }
    if (args[0] === "merge-base") return { status: 0, stdout: "fork-sha", stderr: "" };
    if (args[0] === "diff") return { status: 0, stdout: "a.txt", stderr: "" };
    if (args[0] === "merge-tree") return { status: 0, stdout: "other-tree", stderr: "" };
    if (args[0] === "log") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "cherry") return { status: 0, stdout: "+ abc commit", stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: " M tracked\n?? new file", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/tree",
    readdirSync: () => [], statSync: () => ({ size: 0 }),
  };
  const { rows } = plan({ worktreesKept: [{ path: "/tree", branch: "topic", repo: "/repo" }] }, git, fs,
    { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(rows[0].unlanded, 1);
  equal(rows[0].dirty, 2);
  ok(calls.some(({ args }) => args[0] === "cherry"));
  ok(calls.some(({ args }) => args[0] === "status" && args.includes("--untracked-files=all")));
  deepEqual(blockers(rows), [rows[0]]);
});

test("row 11: measureBytes: false skips the tree walk and rows carry bytes: null", () => {
  const reads = [];
  const fs = {
    existsSync: (p) => p === "/repo" || p === "/tree",
    readdirSync: (p) => { reads.push(p); return p === "/tree" ? [{ name: "a.bin", isDirectory: () => false }] : []; },
    statSync: () => ({ size: 4096 }),
  };
  const git = (args) => (args[0] === "rev-list"
    ? { status: 0, stdout: "1", stderr: "" }
    : { status: 1, stdout: "", stderr: "" });
  const run = { repos: [], resultsDir: null, worktreesKept: [{ branch: null, path: "/tree", repo: "/repo" }] };

  const unmeasured = plan(run, git, fs, { extraBases: [], measureBytes: false, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(unmeasured.rows[0].bytes, null, "an unmeasured row must say so, not claim zero bytes");
  ok(!reads.includes("/tree"), `measureBytes: false must never walk the tree: ${reads.join(", ")}`);

  const measured = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(measured.rows[0].bytes, 4096, "a measured row still carries its byte count for the CLI report");
  ok(reads.includes("/tree"), "the report's sizes come from the walk");
});

test("formatPrune reports nonzero work counts", () => {
  const out = formatPrune([{ path: "/tree", branch: "topic", bytes: 0, unlanded: 3, dirty: 2 }]);
  ok(out.includes("3 unlanded"), out);
  ok(out.includes("2 uncommitted"), out);
});

test("plan: failed cherry and status measurements fail closed as blockers", () => {
  const git = () => ({ status: 1, stdout: "", stderr: "git unavailable" });
  const fs = { existsSync: () => true, readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const { rows } = plan({ worktreesKept: [{ path: "/tree", branch: "topic", repo: "/repo" }] }, git, fs,
    { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(rows[0].unlanded, Infinity);
  equal(rows[0].dirty, Infinity);
  deepEqual(blockers(rows), [rows[0]]);
});

test("row 19: stopAtBlocker ends the plan at the first blocking row; without it every row is measured", () => {
  const calls = [];
  const git = (args) => { calls.push(args[0]); return { status: 1, stdout: "", stderr: "git unavailable" }; };
  const fs = { existsSync: () => true, readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const run = {
    repos: [], resultsDir: null, worktreesKept: [
      { branch: "swarm/a", path: "/tree-a", repo: "/repo" },
      { branch: "swarm/b", path: "/tree-b", repo: "/repo" },
      { branch: "swarm/c", path: "/tree-c", repo: "/repo" },
    ],
  };

  const stopped = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: true, deadline: Infinity, taken: null });
  equal(calls.filter((name) => name === "status").length, 1, "the first blocking row ends the plan");
  equal(stopped.stopped, true);
  equal(stopped.rows.length, 1);

  calls.length = 0;
  const all = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(calls.filter((name) => name === "status").length, 3, "the report measures every row");
  equal(all.stopped, undefined);
  equal(all.rows.length, 3);
});

test("row 20: a deadline already passed measures no row and stops the plan", () => {
  const calls = [];
  const git = (args) => { calls.push(args[0]); return { status: 1, stdout: "", stderr: "" }; };
  const fs = { existsSync: () => true, readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const run = { repos: [], resultsDir: null, worktreesKept: [{ branch: "swarm/a", path: "/tree-a", repo: "/repo" }] };

  const result = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Date.now() - 1, taken: null });
  deepEqual(result, { rows: [], stopped: true });
  equal(calls.filter((name) => name === "for-each-ref").length, 0, "a passed deadline measures no row");
});

test("row 15: the CLI measures through a custom worktreeBranchPrefix, so a sibling agents/ branch is not a landing place", async () => {
  const f = pruneFixture();
  const cfg = { worktreeBranchPrefix: "agents/", treeRoot: join(f.dir, "home", "worktrees") };
  let wt;
  try {
    wt = prepareIsolation({ id: "impl", originalCwd: f.repo, cwd: f.repo }, cfg, f.resultsDir,
      { addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS, base: gitOut(["rev-parse", "HEAD"], f.repo) });
    writeFileSync(join(wt.path, "work.txt"), "x\n");
    commitAll(wt.path, "work");
    // The only ref that reaches the leaf's tip is another branch under the same custom
    // prefix. Under the default `swarm/` it would read as a landing place.
    spawnSync("git", ["branch", "agents/sibling", wt.branch], { cwd: f.repo, windowsHide: true });
    writeFinishedRun(f.resultsDir, [{ branch: wt.branch, path: wt.path }]);

    const r = await runCliInProcess(["prune", f.resultsDir, "--dry-run"], {
      cwd: f.dir,
      env: { SWARM_HOME: join(f.dir, "home") },
      config: cfg,
    });
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("1 unlanded"), `a sibling agents/ branch is not a landing place: ${r.stdout}${r.stderr}`);
  } finally {
    if (wt) spawnSync("git", ["worktree", "remove", "--force", wt.path], { cwd: f.repo, windowsHide: true });
    dropSnapPrune(f);
  }
});

// --- rows 2, 7, 8: a tree whose directory is gone, and the run's branches no tree holds ---

// A registered tree that is no longer on disk measures from what git still knows about
// it: the branch it was on, or the HEAD sha porcelain carries for a detached one.
function missingTreePlan(porcelain, gitFallback) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "worktree" && args[1] === "list") return { status: 0, stdout: porcelain, stderr: "" };
    if (args[0] === "for-each-ref" && !args.includes("--contains")) return { status: 0, stdout: "", stderr: "" };
    return gitFallback(args, cwd);
  };
  const fs = { existsSync: (p) => p === "/repo", readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const run = { repos: ["/repo"], resultsDir: "/results", worktreesKept: [] };
  const result = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  return { ...result, calls };
}

test("row 2: a missing tree measures its branch and reports no uncommitted work", () => {
  const sha = "a".repeat(40);
  const { rows, calls } = missingTreePlan(
    ["worktree /results/wt-gone", `HEAD ${sha}`, "branch refs/heads/swarm/k/leaf"].join("\n"),
    (args) => (args.includes("--contains")
      ? { status: 0, stdout: "refs/heads/master", stderr: "" }
      : { status: 1, stdout: "", stderr: "" }),
  );
  equal(rows.length, 1);
  equal(rows[0].path, resolve("/results/wt-gone"));
  equal(rows[0].missing, true);
  equal(rows[0].unlanded, 0, "the branch tip is on master, so the row is landed");
  equal(rows[0].dirty, 0, "a directory that is gone holds no uncommitted work");
  equal(rows[0].bytes, 0);
  ok(!calls.some(({ args }) => args[0] === "status"), "never run git status against a missing cwd");
});

test("row 2: a missing detached tree measures the HEAD porcelain recorded, and an absent HEAD blocks", () => {
  const sha = "b".repeat(40);
  const measured = missingTreePlan(
    ["worktree /results/wt-gone", `HEAD ${sha}`].join("\n"),
    (args) => (args[0] === "rev-list" ? { status: 0, stdout: "2", stderr: "" } : { status: 1, stdout: "", stderr: "" }),
  );
  equal(measured.rows.length, 1);
  equal(measured.rows[0].unlanded, 2, "commits no branch or remote reaches");
  deepEqual(blockers(measured.rows), measured.rows);
  const revList = measured.calls.find(({ args }) => args[0] === "rev-list");
  equal(revList.cwd, "/repo", "there is no tree to stand in — the repo is the cwd");
  ok(revList.args.includes(sha), `the recorded HEAD is what is measured: ${revList.args.join(" ")}`);

  const unrecorded = missingTreePlan(
    "worktree /results/wt-gone",
    (args) => (args[0] === "rev-list" ? { status: 0, stdout: "0", stderr: "" } : { status: 1, stdout: "", stderr: "" }),
  );
  equal(unrecorded.rows[0].unlanded, Infinity, "no HEAD line is no measurement, never a clean zero");
  deepEqual(blockers(unrecorded.rows), unrecorded.rows);
});

test("row 7: execute gives a path-less row branch -D alone, and a gone repo nothing at all", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  const rmCalls = [];
  const fs = { existsSync: () => true, rmSync: (p, opts) => rmCalls.push({ p, opts }) };
  execute([{ path: null, branch: "swarm/k/leaf", repo: "/repo", bytes: 0, dirty: 0, unlanded: 0 }], git, fs);
  deepEqual(calls, [{ args: ["branch", "-D", "swarm/k/leaf"], cwd: "/repo" }],
    "no worktree remove for a tree that does not exist");
  equal(rmCalls.length, 0, "execute must never rm anything for a branch-only row");

  const goneCalls = [];
  const gone = (args) => { goneCalls.push(args); return { status: 0, stdout: "", stderr: "" }; };
  const goneFs = { existsSync: () => false, rmSync: (p) => rmCalls.push({ p }) };
  execute([{ path: null, branch: "swarm/k/leaf", repo: "/gone", bytes: 0, dirty: 0, unlanded: 0 }], gone, goneFs);
  deepEqual(goneCalls, [], "a path-less row whose repo is gone runs nothing");
  equal(rmCalls.length, 0, "and rms nothing — there is no path to remove");
});

test("row 7: execute removes a missing tree with -f -f, then its branch", () => {
  const calls = [];
  const git = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };
  const fs = { existsSync: () => true, rmSync: () => {} };
  execute([{ path: "/results/wt-gone", branch: "swarm/k/leaf", repo: "/repo", missing: true, bytes: 0, dirty: 0, unlanded: 0 }], git, fs);
  deepEqual(calls, [
    { args: ["worktree", "remove", "-f", "-f", "/results/wt-gone"], cwd: "/repo" },
    { args: ["branch", "-D", "swarm/k/leaf"], cwd: "/repo" },
  ], "a locked missing tree refuses a single --force; both must go, in that order");
});

test("row 7: a branch-only row is measured from its ref alone — no git status, no byte walk", () => {
  const branch = `swarm/${runScopeKey("/results")}/leaf`;
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "worktree") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "for-each-ref" && !args.includes("--contains")) return { status: 0, stdout: branch, stderr: "" };
    if (args[0] === "for-each-ref") return { status: 0, stdout: "refs/heads/master", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const reads = [];
  const fs = { existsSync: (p) => p === "/repo", readdirSync: (p) => { reads.push(p); return []; }, statSync: () => ({ size: 0 }) };
  const { rows } = plan({ repos: ["/repo"], resultsDir: "/results", worktreesKept: [] }, git, fs,
    { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });

  deepEqual(rows, [{ path: null, branch, repo: "/repo", bytes: 0, dirty: 0, unlanded: 0 }]);
  ok(!calls.some(({ args }) => args[0] === "status"), "there is no tree to ask for a working state");
  ok(!reads.includes(null), `a branch-only row must never be walked for bytes: ${reads.join(", ")}`);
  const scan = calls.find(({ args }) => args[0] === "for-each-ref" && !args.includes("--contains"));
  equal(scan.args[2], `refs/heads/swarm/${runScopeKey("/results")}/`, "the run's own namespace is the scan");
});

test("row 7: formatPrune labels a path-less row and counts worktrees and branches apart", () => {
  const rows = [
    { path: "/r/wt-a", branch: "swarm/a", bytes: 1073741824 },
    { path: null, branch: "swarm/b", bytes: 0, unlanded: 0, dirty: 0 },
    { path: null, branch: "swarm/c", bytes: 0, unlanded: 0, dirty: 0 },
    { path: null, branch: "swarm/d", bytes: 0, unlanded: 0, dirty: 0 },
  ];
  const out = formatPrune(rows);
  ok(out.includes("(no tree)"), out);
  ok(/freed 1\.00 GB across 1 worktree and 3 branches/.test(out), out);
});

test("row 21: a branch row is keyed by repo, so the same branch name in another repo is still a row", () => {
  const branch = `swarm/${runScopeKey("/results")}/x`;
  const git = (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return {
        status: 0,
        stdout: cwd === "/repo-a" ? ["worktree /wt-a", "HEAD aaaaaaaa", `branch refs/heads/${branch}`].join("\n") : "",
        stderr: "",
      };
    }
    if (args[0] === "for-each-ref" && !args.includes("--contains")) {
      return { status: 0, stdout: cwd === "/repo-b" ? branch : "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = {
    existsSync: (p) => p === "/repo-a" || p === "/repo-b" || p === "/wt-a",
    readdirSync: () => [],
    statSync: () => ({ size: 0 }),
  };
  const run = { repos: ["/repo-a", "/repo-b"], resultsDir: "/results", worktreesKept: [{ path: "/wt-a", branch, repo: "/repo-a" }] };
  const { rows } = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Infinity, taken: null });
  equal(rows.length, 2, JSON.stringify(rows));
  equal(rows.find((row) => row.path != null)?.repo, "/repo-a");
  const orphan = rows.find((row) => row.path == null);
  equal(orphan?.repo, "/repo-b", "repo B's own branch is a row, not suppressed by repo A's tree row");
  equal(orphan?.branch, branch);
});

test("row 8: a blocking branch-only row stops the plan, and a passed deadline measures none", () => {
  const branches = ["a", "b", "c"].map((n) => `swarm/${runScopeKey("/results")}/${n}`).join("\n");
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === "worktree") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "for-each-ref" && !args.includes("--contains")) return { status: 0, stdout: branches, stderr: "" };
    // Every measurement fails closed, so the first row is a blocker.
    return { status: 1, stdout: "", stderr: "" };
  };
  const fs = { existsSync: (p) => p === "/repo", readdirSync: () => [], statSync: () => ({ size: 0 }) };
  const run = { repos: ["/repo"], resultsDir: "/results", worktreesKept: [] };
  const measured = () => calls.filter((args) => args.includes("--contains")).length;

  const stopped = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: true, deadline: Infinity, taken: null });
  equal(stopped.stopped, true);
  equal(stopped.rows.length, 1);
  equal(measured(), 1, "the first blocking branch row ends the plan");

  calls.length = 0;
  const expired = plan(run, git, fs, { extraBases: [], measureBytes: true, stopAtBlocker: false, deadline: Date.now() - 1, taken: null });
  deepEqual(expired, { rows: [], stopped: true });
  equal(measured(), 0, "a passed deadline measures no branch-only row");
});
