// Which recorded session id travels to a re-dispatch, and what the run log says
// when one does not. Every row asserts on the DISPATCH — the argv the engine
// built — never on a helper, so a predicate that is never consulted by the
// scheduler cannot pass these.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/scheduler.mjs";
import { writeResult, initResultsDir, appendRunLog } from "../src/results.mjs";
import { prepareIsolation } from "../src/worktree.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

const SEAT = { provider: "ollama", model: "nemotron-3-super:cloud" };
const OLLAMA_SID = "s-ollama-1";
const CODEX_SID = "01a0c5a7-de56-74f2-bd2e-696192288102"; // the thread id run.log held
// What a leaf that got turns down leaves behind: the usage each turn recorded.
const TURNS = { input: 480000, output: 26000, cacheCreation: 0, cacheRead: 2400000 };

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-resume-"));
}

function task(id, over = {}) {
  return {
    id, prompt: `do ${id}`, ...SEAT, allowedTools: "Read,Grep,Glob",
    cwd: tmpdir(), originalCwd: tmpdir(), timeoutMs: 5000, after: [], ...over,
  };
}

function plan(dir, tasks) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "" };
}

// The session id the dispatch carried, or null when it was sent cold.
function resumeOf(call) {
  const argv = call.args ?? call.argv;
  const i = argv.indexOf("--resume");
  return i < 0 ? null : argv[i + 1];
}
const argvOf = (call) => (call.args ?? call.argv).join(" ");

function runLog(dir) {
  return readFileSync(join(dir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
function worktreeResume(dir, id) {
  return runLog(dir).filter((e) => e.event === "worktree-resume" && e.id === id).at(-1);
}

// A prior attempt as the engine records it: failed, with whatever the attempt
// got done. `tokens`/`numTurns` are the turn evidence — both absent on an
// attempt that died before its first turn (the real prose.json shape).
function priorAttempt(id, over = {}) {
  return {
    id, ...SEAT, ok: false, exit: 1, durationMs: 2651,
    output: "leaf ended with a runner error: Codex runner exited with code 1",
    ...over,
  };
}

// A real repo: worktree re-entry is the only path that writes worktree-resume.
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-resume-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  return repo;
}

function cleanRepo(repo, dir, wtName) {
  if (wtName) spawnSync("git", ["worktree", "remove", "--force", join(dir, "run", wtName)], { cwd: repo, windowsHide: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

// A leaf that works inside its tree, so collect() keeps the tree it changed.
function writesInTree(call) {
  writeFileSync(join(call.opts.cwd, "worked.txt"), "leaf output\n");
  return { output: "worked" };
}

test("R1: a leaf reseated onto another provider dispatches with no resume", async () => {
  const repo = initRepo();
  const dir = tmp();
  try {
    const p = plan(dir, [task("prose", { cwd: repo, originalCwd: repo, worktreeName: "wt", repoToplevel: repo })]);
    initResultsDir(p.resultsDir);
    // Nine turns down on the old seat, so only the provider predicate can drop
    // this session — the turn predicate has nothing to bite on.
    writeResult(p.resultsDir, "prose", priorAttempt("prose", { numTurns: 9, tokens: TURNS }));
    // run.log still holds the codex thread id from the seat this leaf lost.
    appendRunLog(p.resultsDir, {
      ts: new Date().toISOString(), id: "prose", event: "session",
      sessionId: CODEX_SID, provider: "codex", runner: "codex",
    });
    prepareIsolation({ id: "prose", worktreeName: "wt", cwd: repo, originalCwd: repo }, CFG, p.resultsDir);

    const spawn = fakeSpawnFactory(writesInTree);
    await runPlan(p, CFG, makeIo(spawn));

    equal(spawn.calls.length, 1, "the reseated leaf must be dispatched");
    equal(resumeOf(spawn.calls[0]), null,
      `the dispatch carries another provider's session: ${argvOf(spawn.calls[0])}`);
    const line = worktreeResume(p.resultsDir, "prose");
    equal(line.session, "fresh", "the log line must not call this a resume");
    equal(line.declined, "provider-changed", JSON.stringify(line));
  } finally {
    cleanRepo(repo, dir, "wt-wt");
  }
});

test("R2: a session whose attempt completed no turn is not resumed — same provider", async () => {
  const repo = initRepo();
  const dir = tmp();
  try {
    const p = plan(dir, [task("prose", { cwd: repo, originalCwd: repo, worktreeName: "wt", repoToplevel: repo })]);
    initResultsDir(p.resultsDir);
    // prose.json verbatim in shape: died at turn.failed, exit 1, no tokens, no
    // numTurns key, no session on the result — the id exists only as a run.log
    // record, and the turn count survives only inside the raw output.
    writeResult(p.resultsDir, "prose", priorAttempt("prose", {
      output: "leaf ended with a runner error: Claude runner failed\n"
        + `No conversation found with session ID: ${CODEX_SID}\n`
        + JSON.stringify({
          type: "result", subtype: "error_during_execution", is_error: true,
          num_turns: 0, session_id: CODEX_SID,
        }),
    }));
    appendRunLog(p.resultsDir, {
      ts: new Date().toISOString(), id: "prose", event: "session",
      sessionId: CODEX_SID, provider: "ollama", runner: "claude",
    });
    prepareIsolation({ id: "prose", worktreeName: "wt", cwd: repo, originalCwd: repo }, CFG, p.resultsDir);

    const spawn = fakeSpawnFactory(writesInTree);
    await runPlan(p, CFG, makeIo(spawn));

    // The providers match here, so R1's predicate cannot be what drops it.
    equal(resumeOf(spawn.calls[0]), null,
      `a session with no completed turn must not be resumed: ${argvOf(spawn.calls[0])}`);
    equal(worktreeResume(p.resultsDir, "prose").declined, "no-turns");
  } finally {
    cleanRepo(repo, dir, "wt-wt");
  }
});

test("R3: a same-provider leaf that completed turns before dying still resumes", async () => {
  const repo = initRepo();
  const dir = tmp();
  try {
    const p = plan(dir, [task("impl", { cwd: repo, originalCwd: repo, worktreeName: "wt", repoToplevel: repo })]);
    initResultsDir(p.resultsDir);
    // Forty minutes of work, committed as it went, then the timeout. This is the
    // case the resume carve-out exists for.
    writeResult(p.resultsDir, "impl", priorAttempt("impl", {
      durationMs: 2400000, numTurns: 40, tokens: TURNS, sessionId: OLLAMA_SID,
    }));
    prepareIsolation({ id: "impl", worktreeName: "wt", cwd: repo, originalCwd: repo }, CFG, p.resultsDir);

    const spawn = fakeSpawnFactory(writesInTree);
    await runPlan(p, CFG, makeIo(spawn));

    equal(resumeOf(spawn.calls[0]), OLLAMA_SID,
      `a failed leaf that got turns down must still resume: ${argvOf(spawn.calls[0])}`);
    const line = worktreeResume(p.resultsDir, "impl");
    equal(line.session, "resumed");
    equal(line.declined, undefined, "a resumed leaf declined nothing");
  } finally {
    cleanRepo(repo, dir, "wt-wt");
  }
});

test("R4: a leaf with no recorded session starts cold and claims no decline", async () => {
  const repo = initRepo();
  const dir = tmp();
  try {
    const p = plan(dir, [task("impl", { cwd: repo, originalCwd: repo, worktreeName: "wt", repoToplevel: repo })]);
    initResultsDir(p.resultsDir);
    // A tree from an earlier generation, but no result and no session record for
    // this leaf: there is nothing to decline, so nothing may be claimed.
    prepareIsolation({ id: "impl", worktreeName: "wt", cwd: repo, originalCwd: repo }, CFG, p.resultsDir);

    const spawn = fakeSpawnFactory(writesInTree);
    await runPlan(p, CFG, makeIo(spawn));

    equal(resumeOf(spawn.calls[0]), null, argvOf(spawn.calls[0]));
    const line = worktreeResume(p.resultsDir, "impl");
    equal(line.session, "fresh");
    equal(line.declined, undefined, JSON.stringify(line));
    ok(!runLog(p.resultsDir).some((e) => e.declined), "no entry claims a decline");
  } finally {
    cleanRepo(repo, dir, "wt-wt");
  }
});

test("R4b: an already-ok leaf is still skipped, never re-dispatched", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("impl")]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "impl", priorAttempt("impl", {
      ok: true, exit: 0, tokens: TURNS, sessionId: OLLAMA_SID, output: "already done",
    }));
    const spawn = fakeSpawnFactory(() => ({ output: "should not run" }));
    const r = await runPlan(p, CFG, makeIo(spawn));
    equal(spawn.calls.length, 0, "an ok leaf is never re-dispatched");
    equal(r.summary.tasks[0].state, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R6: --force still resets the tree and clears every session", async () => {
  const repo = initRepo();
  const dir = tmp();
  try {
    const p = plan(dir, [task("impl", { cwd: repo, originalCwd: repo, worktreeName: "wt", repoToplevel: repo })]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "impl", priorAttempt("impl", { numTurns: 40, tokens: TURNS, sessionId: OLLAMA_SID }));
    appendRunLog(p.resultsDir, {
      ts: new Date().toISOString(), id: "impl", event: "session",
      sessionId: OLLAMA_SID, provider: "ollama", runner: "claude",
    });
    const wt = prepareIsolation({ id: "impl", worktreeName: "wt", cwd: repo, originalCwd: repo }, CFG, p.resultsDir);
    writeFileSync(join(wt.path, "partial.txt"), "kept partial work\n");

    const spawn = fakeSpawnFactory(writesInTree);
    await runPlan(p, CFG, makeIo(spawn), { force: true });

    equal(resumeOf(spawn.calls[0]), null, `--force drops every session: ${argvOf(spawn.calls[0])}`);
    equal(worktreeResume(p.resultsDir, "impl").reset, true, "--force resets the tree");
    equal(existsSync(resolve(join(wt.path, "partial.txt"))), false, "the kept partial work is scrubbed");
  } finally {
    cleanRepo(repo, dir, "wt-wt");
  }
});
