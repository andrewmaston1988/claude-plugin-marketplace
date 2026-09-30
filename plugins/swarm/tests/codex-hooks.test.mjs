// Codex runs swarm's hooks with Claude-shaped payloads (session_id, tool_name "Bash",
// tool_input.command) plus turn_id and model — probed live. These
// rows pin the three places the hosts differ, and the prune reminder both hosts share.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateDispatch, isCodexPayload, markerPath, groupingMarkerPath, shapeMarkerPath } from "../hooks/dispatch-gate.mjs";
import { shouldAck, ackTargets } from "../hooks/skill-ack.mjs";
import { launcherSession } from "../src/scheduler.mjs";
import { projectRunsHoldingWorktrees, decidePruneNudge } from "../src/prune-nudge.mjs";
import { renderStatus } from "../src/results-render.mjs";

const CODEX = { session_id: "s", turn_id: "t", model: "gpt-6-luna", tool_name: "Bash" };
const CLAUDE = { session_id: "s", tool_name: "Bash" };
const ARMED = { markerExists: true, groupingMarkerExists: true, shapeMarkerExists: true };

test("a Codex payload is told apart by turn_id and model; a Claude one is not", () => {
  equal(isCodexPayload(CODEX), true);
  equal(isCodexPayload(CLAUDE), false);
  equal(isCodexPayload({ ...CLAUDE, turn_id: "t" }), false);
});

test("Codex has no run_in_background, so an armed foreground dispatch passes there and nowhere else", () => {
  const command = "swarm run C:/m.json";
  equal(gateDispatch({ command, runInBackground: false, ...ARMED, codex: true }).block, false);
  equal(gateDispatch({ command, runInBackground: false, ...ARMED }).block, true);
  // Codex still needs the skills and a bare command.
  equal(gateDispatch({ command, ...ARMED, markerExists: false, codex: true }).block, true);
  equal(gateDispatch({ command: `${command} | tail`, ...ARMED, codex: true }).block, true);
});

test("under Codex, reading a swarm SKILL.md through the shell is the skill invocation", () => {
  const read = (p) => ({ ...CODEX, tool_input: { command: `Get-Content -Raw '${p}'` } });
  const root = "C:\\Users\\a\\.codex\\plugins\\cache\\m\\swarm\\0.1.0\\skills";
  deepEqual(ackTargets(read(`${root}\\swarm\\SKILL.md`)), [markerPath("s")]);
  deepEqual(ackTargets(read(`${root}/orchestrating-agents/SKILL.md`)), [groupingMarkerPath("s")]);
  deepEqual(ackTargets(read(`${root}\\executing-swarms\\SKILL.md`)), [shapeMarkerPath("s")]);
  // Another skill, or the swarm tree without SKILL.md, arms nothing.
  equal(shouldAck(read(`${root}\\commit\\SKILL.md`)), false);
  equal(shouldAck(read(`${root}\\swarm\\references\\setup.md`)), false);
  // On Claude the Skill tool is the invocation; a shell command naming SKILL.md arms nothing.
  equal(shouldAck({ ...CLAUDE, tool_input: { command: `cat '${root}/swarm/SKILL.md'` } }), false);
});

test("the launcher stamp prefers CODEX_SESSION_ID, which a Codex under Claude also inherits CLAUDE_CODE_SESSION_ID beside", () => {
  equal(launcherSession({ CODEX_SESSION_ID: "codex", CLAUDE_CODE_SESSION_ID: "claude" }), "codex");
  equal(launcherSession({ CLAUDE_CODE_SESSION_ID: "claude" }), "claude");
  equal(launcherSession({}), null);
});

// A run dir under <home>/runs/<encoded toplevel>/ — finished unless live or resumed, keeping the given trees.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codex-hooks-"));
  const toplevel = "C:/code/repo";
  const root = join(home, "runs", toplevel.replace(/[\\/:]/g, "-"));
  const run = (name, { kept = [], live = false, resumed = false } = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const t = Date.now() - 60_000;
    writeFileSync(join(dir, "run.log"), JSON.stringify({ ts: t, event: "run-start", tasks: [] }) + "\n");
    // A terminal summary written after run.log is what runLiveness reads as finished.
    if (!live) writeFileSync(join(dir, "summary.json"), JSON.stringify({ started: new Date(t).toISOString(), finished: new Date(t + 1).toISOString(), tasks: [], worktreesKept: kept.map((p) => ({ name: "w", branch: "b", path: p })) }));
    // A resume appends a later run-start: the old summary no longer describes a finished run.
    if (resumed) {
      appendFileSync(join(dir, "run.log"), JSON.stringify({ ts: new Date(t + 30_000).toISOString(), event: "run-start" }) + "\n");
      utimesSync(join(dir, "summary.json"), new Date(t), new Date(t));
    }
    return dir;
  };
  return { home, toplevel, run, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("the prune scan names finished runs in the repo whose kept trees are still on disk, from any session", () => {
  const f = fixture();
  try {
    const tree = join(f.home, "tree");
    mkdirSync(tree);
    const holding = f.run("holding", { kept: [tree] });
    f.run("kept-none");
    f.run("already-pruned", { kept: [join(f.home, "gone")] });
    f.run("resumed", { kept: [tree], resumed: true });
    const runs = projectRunsHoldingWorktrees({ home: f.home, toplevel: f.toplevel });
    deepEqual(runs, [{ dir: holding, kept: 1 }]);
  } finally { f.cleanup(); }
});

test("the prune reminder blocks every stop while any run holds trees, and is silent once none do", () => {
  const runs = [{ dir: "A", kept: 2 }, { dir: "B", kept: 1 }];
  const first = decidePruneNudge({ runs });
  equal(first.block, true);
  ok(first.reason.includes("prune A --dry-run") && first.reason.includes("prune B --dry-run"), first.reason);
  equal(decidePruneNudge({ runs }).block, true, "a second stop asks again");
  equal(decidePruneNudge({ runs: [] }).block, false);
  // Pruning is the operator's call: a leaf or autonomous session is never asked.
  equal(decidePruneNudge({ runs, env: { SWARM_LEAF: "1" } }).block, false);
  equal(decidePruneNudge({ runs, env: { CORRELATION_ID: "c" } }).block, false);
});

test("swarm status on a finished run prints its kept trees and the prune command", () => {
  const f = fixture();
  try {
    const tree = join(f.home, "tree");
    mkdirSync(tree);
    const dir = f.run("holding", { kept: [tree] });
    const out = renderStatus(dir);
    ok(out.includes("worktrees kept:") && out.includes(`prune ${dir}`), out);
    ok(!renderStatus(f.run("kept-none")).includes("prune"), "a run keeping nothing names no prune");
    ok(!renderStatus(f.run("resumed", { kept: [tree], resumed: true })).includes("prune"), "a resumed run is live, not prunable");
  } finally { f.cleanup(); }
});
