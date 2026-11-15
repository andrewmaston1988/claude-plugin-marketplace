// The port nudge: after a HEAD-moving command, a finished run whose branches are all
// provably landed is named with the prune command that frees it. Every row below is the
// trigger, the verdict, or the silence that keeps the line worth reading.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutBase, plan, blockers, runForPrune } from "../src/prune.mjs";
import { pruneMarkerPath } from "../src/prune-nudge.mjs";
import {
  PORT_RE, portingTree, namedSwarmBranches, readTouched, touchedPath, portMarkerPath,
  foreignTouchedRuns, portedRuns, portReason, runPortNudge,
} from "../src/port-nudge.mjs";
import { portFixture, must } from "./helpers/port-fixture.mjs";

const SESSION = "sess-A";
const OTHER = "sess-B";
const HOOK = fileURLToPath(new URL("../hooks/port-nudge.mjs", import.meta.url));

const hookEnv = (home) => {
  const env = { ...process.env, SWARM_HOME: home };
  delete env.SWARM_LEAF;
  delete env.CORRELATION_ID;
  return env;
};

const payload = (over = {}) => ({
  session_id: SESSION,
  cwd: process.cwd(),
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "git status" },
  ...over,
});

// A git runner that records every call, for the silencer rows that must reach git never.
function countingGit() {
  const calls = [];
  return {
    calls,
    run: (args, cwd) => { calls.push({ args, cwd }); return { status: 1, stdout: "", stderr: "" }; },
  };
}

const notARepo = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });

test("row 1: PORT_RE matches the verbs that move HEAD and nothing else", () => {
  for (const command of [
    "git commit -m x",
    "git merge swarm/run/leaf",
    "git cherry-pick abc123",
    "git rebase main",
    "git am 0001.patch",
    "git pull --ff-only",
    'git -C "C:/code/my repo" commit -m x',
    "git -c user.name=t commit -m x",
    "cd repo && git merge topic",
  ]) {
    equal(PORT_RE.test(command), true, command);
  }
  for (const command of [
    "git status",
    "git log --oneline",
    "git fetch origin",
    "git merge-base a b",
    "git merge-tree --write-tree a b",
    "git commit-tree abc",
    "git diff main topic",
    "git apply patch.diff",
    "git checkout main",
    "git push origin topic",
  ]) {
    equal(PORT_RE.test(command), false, command);
  }
});

test("row 2: portingTree takes the one distinct -C path, resolved against cwd, else cwd", () => {
  equal(portingTree('git -C "C:/x/my repo" commit', "C:/work"), resolve("C:/x/my repo"));
  equal(portingTree("git -C sub merge topic", "C:/work"), resolve("C:/work/sub"));
  // Two different checkouts: no single porting tree, so the payload's cwd stands.
  equal(portingTree("git -C a commit && git -C b merge x", "C:/work"), "C:/work");
  // The same path twice is still one.
  equal(portingTree("git -C a status && git -C a commit", "C:/work"), resolve("C:/work/a"));
  equal(portingTree("git commit -m x", "C:/work"), "C:/work");
});

test("row 3: a cherry-pick is ported only when the porting checkout's HEAD is a base", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    f.cherryPick(port, leaf.sha);
    const base = must(["rev-parse", "HEAD"], port);
    const dir = f.run("run-1", { launcher: SESSION, leaves: [leaf] });
    const { run } = runForPrune(dir, { fs, spawnSync: f.spawn });

    // Without the extra base the cherry-picked copy is invisible to git.
    ok(blockers(plan(run, f.git, fs, { extraBases: [], measureBytes: false }).rows).length > 0,
      "with extraBases empty the run must read unlanded");

    const reported = portedRuns({
      home: f.home, toplevel: f.toplevel, sessionId: SESSION, base, branch: "feat", portingTree: port,
      touched: [], cfg: f.cfg, git: f.git, fs, spawnSync: f.spawn, budgetMs: 20_000,
    });
    equal(reported.length, 1);
    equal(reported[0].name, "run-1");
    equal(reported[0].dir, dir);
  } finally { f.cleanup(); }
});

test("row 4: a replay is silent until the git commit that moves HEAD over it", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    const dir = f.run("run-1", { launcher: SESSION, leaves: [leaf] });
    const before = must(["rev-parse", "HEAD"], port);
    f.replay(port, "main", leaf.branch);
    equal(must(["rev-parse", "HEAD"], port), before, "git apply moves no HEAD");

    const args = { home: f.home, toplevel: f.toplevel, sessionId: SESSION, branch: "feat", portingTree: port, touched: [], cfg: f.cfg, git: f.git, fs, spawnSync: f.spawn, budgetMs: 20_000 };
    deepEqual(portedRuns({ ...args, base: before }), [], "an unmoved HEAD proves nothing");

    must(["add", "-A"], port);
    must(["commit", "-qm", "replay the leaf"], port);
    const after = must(["rev-parse", "HEAD"], port);
    equal(portedRuns({ ...args, base: after }).length, 1, "the commit holds the ported patch");
    ok(fs.existsSync(join(dir, "summary.json")));
  } finally { f.cleanup(); }
});

test("row 5: a partly landed run, a dirty tree, and a live run are all silent", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const one = f.leaf("run-1", "one");
    const two = f.leaf("run-1", "two");
    f.cherryPick(port, one.sha);
    const base = must(["rev-parse", "HEAD"], port);
    const args = { home: f.home, toplevel: f.toplevel, sessionId: SESSION, base, branch: "feat", portingTree: port, touched: [], cfg: f.cfg, git: f.git, fs, spawnSync: f.spawn, budgetMs: 20_000 };

    f.run("run-1", { launcher: SESSION, leaves: [one, two] });
    deepEqual(portedRuns(args), [], "one unlanded branch keeps the whole run silent");

    // Land the second branch too, then leave an uncommitted file in its tree.
    f.cherryPick(port, two.sha);
    fs.writeFileSync(join(two.path, "scratch.txt"), "uncommitted\n");
    deepEqual(portedRuns({ ...args, base: must(["rev-parse", "HEAD"], port) }), [], "an untracked file keeps the run silent");

    fs.rmSync(join(two.path, "scratch.txt"));
    equal(portedRuns({ ...args, base: must(["rev-parse", "HEAD"], port) }).length, 1, "precondition: clean and landed is reported");

    // A live run's trees are not this session's to prune, however its branches are named.
    const liveLeaf = f.leaf("live", "leaf");
    f.cherryPick(port, liveLeaf.sha);
    const liveDir = f.run("live-run", { launcher: SESSION, leaves: [liveLeaf] });
    fs.rmSync(join(liveDir, "summary.json"));
    fs.writeFileSync(join(liveDir, "heartbeat"), `${new Date().toISOString()} 1234\n`);
    const withLive = portedRuns({ ...args, base: must(["rev-parse", "HEAD"], port), touched: [liveLeaf.branch] });
    ok(!withLive.some((r) => r.name === "live-run"),
      `a live run is never measured, however its branches are named: ${withLive.map((r) => r.name)}`);
  } finally { f.cleanup(); }
});

test("row 6: port-nudged silences this session only, and prune-nudged never does", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    f.cherryPick(port, leaf.sha);
    // Dispatched elsewhere: the run is reachable for either session only through the
    // branch each session's own commands named.
    const dir = f.run("run-1", { launcher: "sess-X", leaves: [leaf] });
    for (const id of [SESSION, OTHER, "sess-C"]) fs.writeFileSync(touchedPath(f.home, id), `${leaf.branch}\n`);
    const nudge = (sessionId) => runPortNudge({
      payload: payload({ session_id: sessionId, cwd: port, tool_input: { command: `git cherry-pick ${leaf.sha}` } }),
      env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs,
    });

    notEqual(nudge(SESSION), "");
    equal(fs.readFileSync(portMarkerPath(dir), "utf8"), SESSION);
    equal(nudge(SESSION), "", "the same session is told once");

    notEqual(nudge(OTHER), "", "another session is told");
    equal(fs.readFileSync(portMarkerPath(dir), "utf8"), OTHER);

    // The per-turn marker is a different nudge's: it must never eat this one.
    fs.writeFileSync(pruneMarkerPath(dir), "sess-C");
    notEqual(nudge("sess-C"), "", "prune-nudged does not silence the port nudge");
  } finally { f.cleanup(); }
});

test("row 7: every silencer exits silent and reaches git never", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    f.cherryPick(port, leaf.sha);
    f.run("run-1", { launcher: SESSION, leaves: [leaf] });
    const command = `git cherry-pick ${leaf.sha}`;
    const base = { payload: payload({ cwd: port, tool_input: { command } }), env: {}, config: f.cfg, home: f.home, spawn: f.spawn, fs };

    const cases = [
      ["SWARM_LEAF", { env: { SWARM_LEAF: "1" } }],
      ["CORRELATION_ID", { env: { CORRELATION_ID: "corr" } }],
      ["pruneNudge false", { config: { ...f.cfg, swarm: { pruneNudge: false } } }],
      ["no session id", { payload: payload({ session_id: "", cwd: port, tool_input: { command } }) }],
      ["tool_name Read", { payload: payload({ tool_name: "Read", cwd: port, tool_input: { command } }) }],
      ["wrong event", { payload: payload({ hook_event_name: "PreToolUse", cwd: port, tool_input: { command } }) }],
      ["cwd outside a repo", { payload: payload({ cwd: join(f.home, "nowhere"), tool_input: { command } }), spawn: notARepo }],
    ];
    for (const [label, over] of cases) {
      const git = countingGit();
      equal(runPortNudge({ ...base, ...over, git: git.run }), "", label);
      equal(git.calls.length, 0, `${label}: git must not be consulted`);
    }

    // Unparseable stdin is the hook binary's own guard.
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8", env: hookEnv(f.home), windowsHide: true });
    equal(r.status, 0);
    equal(r.stdout, "");
  } finally { f.cleanup(); }
});

test("row 8: a foreign run is measured once its branch is named, and an unnamed one never is", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const one = f.leaf("run-1", "leaf");
    const two = f.leaf("run-2", "leaf");
    for (const [name, leaf] of [["run-1", one], ["run-2", two]]) {
      f.cherryPick(port, leaf.sha);
      f.run(name, { launcher: OTHER, leaves: [leaf] });
    }
    const nudge = (command) => runPortNudge({
      payload: payload({ cwd: port, tool_input: { command } }),
      env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs,
    });

    // A read-only command records the branch without measuring anything.
    equal(nudge(`git status ${one.branch}`), "");
    deepEqual(readTouched({ home: f.home, sessionId: SESSION, fs }), [one.branch]);
    deepEqual(foreignTouchedRuns({ home: f.home, toplevel: f.toplevel, touched: readTouched({ home: f.home, sessionId: SESSION, fs }), fs }).length, 1);

    const output = JSON.parse(nudge("git commit -m port"));
    const context = output.hookSpecificOutput.additionalContext;
    ok(context.includes("`run-1`"), context);
    ok(!context.includes("`run-2`"), `an unnamed foreign run is never measured: ${context}`);
  } finally { f.cleanup(); }
});

test("row 9: an unfinished task is named, and pruning is said to end its resume", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    f.cherryPick(port, leaf.sha);
    f.run("run-1", { launcher: SESSION, leaves: [leaf], tasks: [{ id: "leaf", state: "ok" }, { id: "other", state: "failed" }] });
    const output = JSON.parse(runPortNudge({
      payload: payload({ cwd: port, tool_input: { command: `git cherry-pick ${leaf.sha}` } }),
      env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs,
    }));
    const context = output.hookSpecificOutput.additionalContext;
    ok(context.includes("(1 task did not finish ok — pruning ends their resume)"), context);

    const clean = portReason({ dir: "D", name: "r", rows: [{}, {}], base: "a".repeat(40), branch: "feat", portingTree: "P", tasks: [{ state: "ok" }] });
    ok(!clean.includes("did not finish ok"), clean);
    ok(clean.includes("all 2 branches landed in `feat`@`aaaaaaa`"), clean);
  } finally { f.cleanup(); }
});

test("row 16: a detached checkout and a swarm-branch checkout are never a base", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    f.cherryPick(port, leaf.sha);
    const dir = f.run("run-1", { launcher: SESSION, leaves: [leaf] });
    ok(fs.existsSync(dir));
    const prefix = f.cfg.worktreeBranchPrefix;

    ok(checkoutBase(f.git, port, [f.toplevel], prefix), "precondition: a named feature branch is a base");

    must(["checkout", "-q", "--detach"], port);
    equal(checkoutBase(f.git, port, [f.toplevel], prefix), null, "a detached HEAD is no base");
    equal(runPortNudge({
      payload: payload({ cwd: port, tool_input: { command: `git cherry-pick ${leaf.sha}` } }),
      env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs,
    }), "", "the hook stays silent on a detached porting checkout");

    must(["checkout", "-q", "feat"], port);
    equal(checkoutBase(f.git, leaf.path, [f.toplevel], prefix), null, "a leaf's own swarm branch is no base");
    equal(runPortNudge({
      payload: payload({ cwd: leaf.path, tool_input: { command: `git merge ${leaf.sha}` } }),
      env: {}, config: f.cfg, home: f.home, git: f.git, spawn: f.spawn, fs,
    }), "", "the hook stays silent inside a leaf worktree");
  } finally { f.cleanup(); }
});

test("row 18: a PostToolUseFailure payload is measured and echoed back", () => {
  const f = portFixture();
  const port = f.porting();
  try {
    const leaf = f.leaf("run-1", "leaf");
    must(["merge", "-q", "--ff-only", leaf.branch], port);
    f.run("run-1", { launcher: SESSION, leaves: [leaf] });

    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: SESSION,
        cwd: port,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: `git merge ${leaf.branch} && false` },
        error: "Command failed with exit code 1",
        is_interrupt: false,
        duration_ms: 12,
      }),
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      env: hookEnv(f.home),
    });
    equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    equal(output.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    ok(output.hookSpecificOutput.additionalContext.includes("`run-1` is ported"), r.stdout);
    ok(output.hookSpecificOutput.additionalContext.includes("prune"), r.stdout);
  } finally { f.cleanup(); }
});

test("namedSwarmBranches reads the configured prefix out of a command", () => {
  deepEqual(namedSwarmBranches("git merge swarm/run-1/leaf && git push", "swarm/"), ["swarm/run-1/leaf"]);
  deepEqual(namedSwarmBranches("git merge agents/run-1/leaf", "agents/"), ["agents/run-1/leaf"]);
  deepEqual(namedSwarmBranches("git merge agents/run-1/leaf", "swarm/"), []);
  deepEqual(namedSwarmBranches("git cherry-pick swarm/a/b; git log swarm/c/d", "swarm/"), ["swarm/a/b", "swarm/c/d"]);
});
