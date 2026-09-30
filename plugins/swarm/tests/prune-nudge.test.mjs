// The prune reminder is one line about THIS session's runs, and the list it points at
// lives in `swarm status --mine`'s output where the terminal collapses it. Every row
// below is literal: the reason string, the listing lines, the marker's contents.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRunsHoldingWorktrees, decidePruneNudge, formatMineStatus, writePruneMarker, pruneMarkerPath } from "../src/prune-nudge.mjs";
import { realRepoToplevel } from "../src/manifest-leaf-guard.mjs";
import { runsKeyFor, enginePath } from "../src/config.mjs";
import { runCli } from "./helpers/cli.mjs";

const SESSION = "sess-A";
const OTHER = "sess-B";
const CLI = enginePath();
const HOOK = fileURLToPath(new URL("../hooks/prune-nudge.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("..", import.meta.url));

// A real git repo, because the hook resolves the Stop payload's cwd through
// `git worktree list`. Runs are filed under whatever toplevel git reports, so the
// fixture asks the same function rather than guessing the path's spelling.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "prune-nudge-"));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  const toplevel = realRepoToplevel(repo) || repo;
  const root = join(home, "runs", runsKeyFor(toplevel));
  const tree = (name) => {
    const p = join(home, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const run = (name, { kept = [], live = false, launcher } = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const t = Date.now() - 60_000;
    writeFileSync(join(dir, "run.log"), JSON.stringify({ ts: t, event: "run-start", ...(launcher === undefined ? {} : { launcher }), tasks: [] }) + "\n");
    if (!live) {
      writeFileSync(join(dir, "summary.json"), JSON.stringify({
        started: new Date(t).toISOString(),
        finished: new Date(t + 1).toISOString(),
        tasks: [],
        worktreesKept: kept.map((p) => ({ name: "w", branch: "b", path: p })),
      }));
    }
    return dir;
  };
  return { home, repo, toplevel, run, tree, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// The env the CLI and the hook resolve the session from. `SWARM_LEAF` and
// `CORRELATION_ID` are stripped: the suite itself may run inside a swarm leaf,
// where both are set, and the hook is silent there by design.
function env(home, sessionId) {
  const e = { ...process.env, SWARM_HOME: home, SWARM_REPAINT: "0" };
  delete e.SWARM_LEAF;
  delete e.CORRELATION_ID;
  // "" is falsy, so both empty means "no session" without runCli's env spread
  // resurrecting whatever the developer's shell exported.
  e.CODEX_SESSION_ID = sessionId || "";
  e.CLAUDE_CODE_SESSION_ID = sessionId || "";
  return e;
}

function spawnHook(payload, home) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: env(home, SESSION),
  });
}

const reason1 = "1 worktree from runs in this session — run `swarm status --mine`, take anything you still need, then prune them.";

test("a finished run another session launched is counted, never listed", () => {
  const f = fixture();
  try {
    const tree = f.tree("tree");
    const mine = f.run("mine", { kept: [tree], launcher: SESSION });
    f.run("theirs", { kept: [tree], launcher: OTHER });
    // No launcher at all: nobody's run, so nobody is nudged about it.
    f.run("orphan", { kept: [tree] });
    f.run("mine-empty", { kept: [join(f.home, "gone")], launcher: SESSION });
    const { mine: myRuns, others } = projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel, sessionId: SESSION });
    deepEqual(myRuns, [{ dir: mine, kept: 1 }]);
    equal(others, 1);
  } finally { f.cleanup(); }
});

test("the block reason is exactly one line: this session's worktree count, (and N others) only when N > 0, and swarm status --mine", () => {
  const reason = decidePruneNudge({ mine: [{ dir: "A", kept: 3 }], others: 9 }).reason;
  equal(reason, "3 worktrees from runs in this session (and 9 others) — run `swarm status --mine`, take anything you still need, then prune them.");
  equal(reason.includes("\n"), false, "one line, whatever the run count");
  equal(decidePruneNudge({ mine: [{ dir: "A", kept: 1 }], others: 0 }).reason, reason1);
  equal(decidePruneNudge({ mine: [{ dir: "A", kept: 2 }], others: 1 }).reason,
    "2 worktrees from runs in this session (and 1 other) — run `swarm status --mine`, take anything you still need, then prune them.");
  equal(decidePruneNudge({ mine: [{ dir: "A", kept: 2 }, { dir: "B", kept: 1 }], others: 0 }).reason,
    "3 worktrees from runs in this session — run `swarm status --mine`, take anything you still need, then prune them.");
  // Another session's trees are counted, never a reason to block on their own.
  equal(decidePruneNudge({ mine: [], others: 5 }).block, false);
  // Pruning a finished run is clean-up, not a question: a leaf or autonomous session is still never asked.
  equal(decidePruneNudge({ mine: [{ dir: "A", kept: 1 }], env: { SWARM_LEAF: "1" } }).block, false);
  equal(decidePruneNudge({ mine: [{ dir: "A", kept: 1 }], env: { CORRELATION_ID: "c" } }).block, false);
  // The operator can switch it off, like the sibling nudges.
  equal(decidePruneNudge({ mine: [{ dir: "A", kept: 1 }], config: { swarm: { pruneNudge: false } } }).block, false);
});

test("the hook binary writes prune-nudged into the run it named and is silent at the second stop", () => {
  const f = fixture();
  try {
    const dir = f.run("holding", { kept: [f.tree("tree")], launcher: SESSION });
    const payload = { session_id: SESSION, cwd: f.repo, hook_event_name: "Stop", stop_hook_active: false };
    const first = spawnHook(payload, f.home);
    equal(first.stdout, JSON.stringify({ decision: "block", reason: reason1 }) + "\n");
    equal(existsSync(pruneMarkerPath(dir)), true, "the named run is marked");
    equal(readFileSync(pruneMarkerPath(dir), "utf8"), SESSION);
    // Named once: the same session's next stop is silent, and the run is still listed
    // by `status --mine` while its trees remain.
    equal(spawnHook(payload, f.home).stdout, "");
    const { mine } = projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel, sessionId: SESSION });
    deepEqual(mine, []);
  } finally { f.cleanup(); }
});

test("a resume by another session (a new launcher) is nudged once more", () => {
  const f = fixture();
  try {
    const dir = f.run("holding", { kept: [f.tree("tree")], launcher: OTHER });
    writePruneMarker(dir, OTHER);
    // The resumer now owns the run: the marker records the old launcher, so the new
    // one is told once — and the run is still not this session's while it is theirs.
    equal(projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel, sessionId: OTHER }).mine.length, 0);
    deepEqual(projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel, sessionId: SESSION }).mine, []);
    // Re-stamped by the resume: the last run-start wins, exactly as grade-nudge reads it.
    writeFileSync(join(dir, "run.log"), JSON.stringify({ ts: Date.now(), event: "run-start", launcher: SESSION, tasks: [] }) + "\n");
    deepEqual(projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel, sessionId: SESSION }).mine, [{ dir, kept: 1 }]);
    const second = spawnHook({ session_id: SESSION, cwd: f.repo, hook_event_name: "Stop" }, f.home);
    equal(second.stdout, JSON.stringify({ decision: "block", reason: reason1 }) + "\n");
    equal(readFileSync(pruneMarkerPath(dir), "utf8"), SESSION);
  } finally { f.cleanup(); }
});

test("no session id in the payload makes the hook silent", () => {
  const f = fixture();
  try {
    f.run("holding", { kept: [f.tree("tree")], launcher: SESSION });
    const r = spawnHook({ cwd: f.repo, hook_event_name: "Stop" }, f.home);
    equal(r.status, 0);
    equal(r.stdout, "");
  } finally { f.cleanup(); }
});

test("swarm status --mine lists only this session's finished runs holding trees, each with its prune command", () => {
  const f = fixture();
  try {
    const tree = f.tree("tree");
    const a = f.run("alpha", { kept: [tree, tree], launcher: SESSION });
    const b = f.run("beta", { kept: [tree], launcher: SESSION });
    const theirs = f.run("theirs", { kept: [tree], launcher: OTHER });
    const r = runCli(["status", "--mine"], { cwd: f.repo, env: { SWARM_HOME: f.home, CODEX_SESSION_ID: SESSION, CLAUDE_CODE_SESSION_ID: SESSION } });
    equal(r.status, 0, r.stderr);
    equal(r.stdout, [
      "swarm status --mine: 2 finished runs this session dispatched hold 3 kept worktrees.",
      `  node ${CLI} prune ${a} --dry-run   (2 trees)`,
      `  node ${CLI} prune ${b} --dry-run   (1 tree)`,
      "Other sessions' runs hold 1 more (not this session's to prune).",
      "Take anything you still need, then prune them: `prune` deletes a run's worktrees and branches, never its results.",
      "",
    ].join("\n"));
    equal(r.stdout.includes(theirs), false, "another session's run is never listed");
  } finally { f.cleanup(); }
});

test("swarm status --mine outside a session exits 1 and lists nothing", () => {
  const f = fixture();
  try {
    f.run("holding", { kept: [f.tree("tree")], launcher: SESSION });
    // Both emptied, not omitted: runCli spreads process.env, and the suite may itself
    // be running inside a session whose id would leak into the child.
    const r = runCli(["status", "--mine"], { cwd: f.repo, env: { SWARM_HOME: f.home, CODEX_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" } });
    equal(r.status, 1);
    equal(r.stdout, "");
    ok(r.stderr.includes("CODEX_SESSION_ID"), r.stderr);
  } finally { f.cleanup(); }
});

test("swarm status --mine names no run once the session has nothing left holding trees", () => {
  const f = fixture();
  try {
    f.run("cleaned", { kept: [join(f.home, "gone")], launcher: SESSION });
    const r = runCli(["status", "--mine"], { cwd: f.repo, env: { SWARM_HOME: f.home, CODEX_SESSION_ID: SESSION, CLAUDE_CODE_SESSION_ID: SESSION } });
    equal(r.status, 0, r.stderr);
    equal(r.stdout, "swarm status --mine: no finished run this session dispatched is holding kept worktrees.\n");
  } finally { f.cleanup(); }
});

test("the mine listing is built from the same runs the hook decides on", () => {
  deepEqual(formatMineStatus({ mine: [], others: 0 }), ["swarm status --mine: no finished run this session dispatched is holding kept worktrees."]);
  deepEqual(formatMineStatus({ mine: [{ dir: "A", kept: 1 }], others: 0 }), [
    "swarm status --mine: 1 finished run this session dispatched holds 1 kept worktree.",
    `  node ${CLI} prune A --dry-run   (1 tree)`,
    "Take anything you still need, then prune them: `prune` deletes a run's worktrees and branches, never its results.",
  ]);
});

// --- the grep pin ------------------------------------------------------------------
// The reading this pins out: pruning a FINISHED run is the operator's call, so the model
// asks instead of cleaning up. A scoped rule about a failed leaf's tree is a different
// reading and lives on its own line — the pin is per line, not per file.
const PRUNE = /\bprun/i;
const OPERATOR_DECIDES = /operator'?s (call|decision)|operator decides|(?<!not |don't |never )ask the operator|never yours|operator'?s alone/i;

function read(rel) {
  return readFileSync(join(PLUGIN, rel), "utf8");
}

function linesClaimingItIsNotYours(text) {
  return text.split(/\r?\n/).filter((l) => PRUNE.test(l) && OPERATOR_DECIDES.test(l));
}

// From `marker` to the next level-2 heading — the block a table or list occupies.
function sectionFrom(text, marker) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(marker));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

test("nothing calls pruning a finished run the operator's call", () => {
  const skill = read("skills/swarm/SKILL.md");
  const roster = read("skills/swarm/references/reading-the-roster.md");
  const readmePrune = read("README.md").split(/\r?\n\r?\n/).filter((b) => b.includes("`swarm prune"))[0] || "";
  const step9 = skill.split(/\r?\n/).filter((l) => l.includes("`prune <resultsDir>`")).join("\n");

  ok(step9.length > 0, "SKILL.md still documents `prune <resultsDir>`");
  ok(readmePrune.length > 0, "README still documents `swarm prune`");

  const regions = [
    ["src/prune-nudge.mjs", read("src/prune-nudge.mjs")],
    ["hooks/prune-nudge.mjs", read("hooks/prune-nudge.mjs")],
    ["the block reason", decidePruneNudge({ mine: [{ dir: "A", kept: 3 }], others: 9 }).reason],
    ["status --mine output", formatMineStatus({ mine: [{ dir: "A", kept: 2 }], others: 9 }).join("\n")],
    ["SKILL.md step 9", step9],
    ["SKILL.md's red-flag table", sectionFrom(skill, "Rationalisations that preceded the real incident")],
    ["reading-the-roster.md", roster],
    ["the README prune paragraph", readmePrune],
  ];
  for (const [label, text] of regions) {
    deepEqual(linesClaimingItIsNotYours(text), [], `${label} names pruning and an operator decision on one line`);
  }
  // The hook's whole source IS its text — every comment ships to whoever reads it —
  // so no possessive-call phrase survives anywhere in those two files.
  for (const rel of ["src/prune-nudge.mjs", "hooks/prune-nudge.mjs"]) {
    equal(/operator'?s call|reader'?s call|never yours/i.test(read(rel)), false, rel);
  }
});
