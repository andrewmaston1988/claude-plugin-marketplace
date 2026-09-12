import { test } from "node:test";
import { equal, ok, rejects, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { askLeaf } from "../src/ask.mjs";
import { runPlan } from "../src/scheduler.mjs";
import {
  initResultsDir, writeResult, readResult, writeManifestSnapshot, heartbeatPath,
} from "../src/results.mjs";
import { runLiveness, readRun } from "../src/runlog.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import * as defaultWorktree from "../src/worktree.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  timeoutMs: 600000,
};

function setup(resultOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-"));
  initResultsDir(dir);
  writeResult(dir, "leaf", {
    id: "leaf", model: "haiku", ok: true, exit: 0, durationMs: 5,
    output: "original finding", sessionId: "s-1", cwd: tmpdir(), allowedTools: "Read,Grep",
    ...resultOver,
  });
  writeManifestSnapshot(dir, { cwd: tmpdir(), resultsDir: dir, tasks: [{ id: "leaf", model: "haiku" }] });
  return dir;
}

const STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s-2" }),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "the follow-up answer",
    usage: { input_tokens: 900, output_tokens: 80 },
  }),
].join("\n") + "\n";

test("askLeaf resumes the leaf session with its own model, cwd, and tools", async () => {
  const dir = setup();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const io = makeIo(spawn);
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "why though?", cfg: CFG, io });

    equal(r.answer, "the follow-up answer");
    equal(r.tokens.input, 900);
    const call = spawn.calls[0];
    equal(promptOf(call), "why though?");
    const args = call.args;
    equal(args[args.indexOf("--resume") + 1], "s-1");
    equal(args[args.indexOf("--model") + 1], "haiku");
    equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep");
    equal(call.opts.cwd, tmpdir());

    // thread continuity: next ask resumes the NEW session id
    equal(readResult(dir, "leaf").sessionId, "s-2");
    // Q/A appended to the interrogation log
    const log = readFileSync(join(dir, "results", "leaf.ask.log"), "utf8");
    ok(log.includes("why though?"), log);
    ok(log.includes("the follow-up answer"), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: readable errors for unknown leaf, missing sessionId, vanished cwd", async () => {
  const dir = setup();
  try {
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "ghost", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /no result/);
    writeResult(dir, "old", { id: "old", model: "haiku", ok: true, output: "x", cwd: tmpdir() });
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "old", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /sessionId/);
    writeResult(dir, "gone", { id: "gone", model: "haiku", ok: true, output: "x", sessionId: "s-9", cwd: join(tmpdir(), "swarm-nonexistent-wt-xyz") });
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "gone", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /no longer exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: --model override to an open model re-runs the governance gate", async () => {
  const dir = setup();
  try {
    // cwd (tmpdir) not under allowedRoots -> refused before any spawn
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    await rejects(
      () => askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", model: "glm-4.6:cloud", cfg: CFG, io: makeIo(spawn) }),
      /governance/i
    );
    equal(spawn.calls.length, 0);

    // under an allowed root -> dispatches with the env trio
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    const io2 = makeIo(spawn2);
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", model: "glm-4.6:cloud", cfg: cfgAllowed, io: io2 });
    equal(r.answer, "the follow-up answer");
    equal(spawn2.calls[0].opts.env.ANTHROPIC_MODEL, "glm-4.6:cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: governance gates on originalCwd for scratch-redirected leaves", async () => {
  // a write-capable open-model leaf runs in a scratch dir (never under
  // allowedRoots) but was approved against its ORIGINAL cwd — ask must honor
  // the same pair the manifest gate approved
  const dir = setup({ cwd: tmpdir(), originalCwd: join(tmpdir(), "approved-root") });
  try {
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [join(tmpdir(), "approved-root")] } };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", model: "glm-4.6:cloud", cfg: cfgAllowed, io: makeIo(spawn) });
    equal(r.answer, "the follow-up answer");
    equal(spawn.calls[0].opts.cwd, tmpdir()); // resume still runs in the leaf's actual cwd
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: a failed resume surfaces ok:false, does not update sessionId", async () => {
  const dir = setup();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "No conversation found with session ID s-1" }));
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", cfg: CFG, io: makeIo(spawn) });
    equal(r.ok, false);
    ok(r.answer.includes("No conversation found"), r.answer);
    equal(readResult(dir, "leaf").sessionId, "s-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: resumes a forEach clone whose id is not a top-level manifest task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-clone-"));
  try {
    initResultsDir(dir);
    // "fix" is the forEach parent in the manifest; "fix[0]" only exists as an
    // expanded clone with its own result — never a key in manifest.tasks.
    writeManifestSnapshot(dir, { cwd: tmpdir(), resultsDir: dir, tasks: [{ id: "fix", model: "haiku", forEach: { over: "{{x}}" } }] });
    writeResult(dir, "fix[0]", {
      id: "fix[0]", model: "haiku", ok: true, exit: 0, durationMs: 5,
      output: "clone finding", sessionId: "s-clone", cwd: tmpdir(), allowedTools: "Read,Grep",
    });
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const io = makeIo(spawn);
    const r = await askLeaf({ resultsDir: dir, taskId: "fix[0]", question: "why though?", cfg: CFG, io });

    equal(r.answer, "the follow-up answer");
    const args = spawn.calls[0].args;
    equal(args[args.indexOf("--resume") + 1], "s-clone");
    equal(readResult(dir, "fix[0]").asks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Q1-Q7: ask mode through runPlan directly (test plan swarm-ask-in-run-test-plan.md) ──

const SCHED_CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function schedTask(id, over = {}) {
  return {
    id, prompt: `do ${id}`, model: "haiku", allowedTools: "Read,Grep,Glob",
    cwd: over.cwd || tmpdir(), originalCwd: over.cwd || tmpdir(),
    scratchRedirect: false, timeoutMs: 5000, after: [], ...over,
  };
}

function schedPlan(dir, tasks, over = {}) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "", ...over };
}

function streamInit(sid, text) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sid }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n") + "\n";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finishedRun(tasks, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-run-"));
  const p = schedPlan(dir, tasks, over);
  const spawn = fakeSpawnFactory((call) => {
    const m = promptOf(call)?.match(/^do (.+)/);
    const id = m ? m[1] : "digest";
    return { output: streamInit(`s-${id}`, `output for ${id}`) };
  });
  await runPlan(p, SCHED_CFG, makeIo(spawn));
  return { dir, plan: p, spawn };
}

test("Q1: ask appends a run-start with ask:<id>, leaf goes running -> ok, heartbeat touched", async () => {
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "why?" } });
    equal(r.summary.tasks.find((t) => t.id === "a").state, "ok");
    const lines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.event === "run-start");
    equal(starts.length, 2);
    equal(starts[1].ask, "a");
    const aLines = lines.filter((l) => l.id === "a" && l.state);
    ok(aLines.some((l) => l.state === "running"), JSON.stringify(aLines));
    ok(aLines.some((l) => l.state === "ok"), JSON.stringify(aLines));
    ok(existsSync(heartbeatPath(p.resultsDir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q2: mid-ask, runLiveness reports the run live (not finished)", async () => {
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    // The ask's run-start must land strictly after the prior run's summary.finished —
    // equal-ms is the OWNING run's own summary, not a stale one to supersede (see
    // summarySuperseded). A fast machine can otherwise write both in the same ms.
    await sleep(5);
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM, delayMs: 80 }));
    const runPromise = runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "?" } });
    try {
      await sleep(20);
      const mid = runLiveness(p.resultsDir, { heartbeatMs: 15000 });
      ok(mid.finishedMs == null && mid.stoppedMs == null && mid.abortedMs == null, JSON.stringify(mid));
    } finally {
      await runPromise;
    }
    const after = runLiveness(p.resultsDir, { heartbeatMs: 15000 });
    ok(after.finishedMs != null, JSON.stringify(after));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q3: only the asked leaf spawns; dependents and __digest keep their finished state", async () => {
  const { dir, plan: p } = await finishedRun(
    [schedTask("a"), schedTask("b", { after: ["a"] })],
    { digest: { model: "haiku", instructions: "sum up" } }
  );
  try {
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "?" } });
    equal(spawn2.calls.length, 1, "only the asked leaf spawns");
    // b and the digest already finished "ok" in the prior run — an ask must not
    // relabel them, since nothing about them re-ran.
    equal(r.summary.tasks.find((t) => t.id === "b").state, "ok");
    equal(r.summary.tasks.find((t) => t.id === DIGEST_ID).state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q4: the leaf's output/ok is unchanged; asks[] gains an entry; .ask.log is appended", async () => {
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    const before = readResult(p.resultsDir, "a");
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "why though?" } });
    const after = readResult(p.resultsDir, "a");
    equal(after.output, before.output);
    equal(after.ok, true);
    equal(after.asks.length, 1);
    equal(after.asks[0].question, "why though?");
    equal(after.asks[0].answer, "the follow-up answer");
    equal(after.asks[0].model, "haiku");
    ok(after.asks[0].tokens);
    equal(after.asks[0].sessionId, "s-2");
    const log = readFileSync(join(p.resultsDir, "results", "a.ask.log"), "utf8");
    ok(log.includes("why though?"), log);
    ok(log.includes("the follow-up answer"), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q5: the ask resumes the recorded sessionId, even though the prior result is ok", async () => {
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    equal(readResult(p.resultsDir, "a").ok, true);
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "?" } });
    const args = spawn2.calls[0].args;
    equal(args[args.indexOf("--resume") + 1], "s-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q9: with no ask.model override, the ask spawns with the leaf's actual result.model, not its manifest model", async () => {
  // the leaf's manifest model is "haiku", but its dispatch fell back to
  // "sonnet" before it ran — result.model is the model that actually ran,
  // and governance already checked THAT one.
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    const prior = readResult(p.resultsDir, "a");
    writeResult(p.resultsDir, "a", { ...prior, model: "sonnet" });
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "?" } });
    const args = spawn2.calls[0].args;
    equal(args[args.indexOf("--model") + 1], "sonnet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q6: ask in a kept worktree reuses it without calling prepareIsolation", async () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-ask-repo-"));
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-wt-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  const wtPath = join(dir, "run", "wt-impl");
  try {
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 2, goal: "",
      tasks: [{
        id: "impl", prompt: "implement", model: "haiku", allowedTools: "Read,Edit,Bash",
        cwd: repo, originalCwd: repo, scratchRedirect: false, isolation: "worktree",
        timeoutMs: 5000, after: [],
      }],
    };
    const spawn = fakeSpawnFactory((call) => {
      writeFileSync(join(call.opts.cwd, "made-by-leaf.txt"), "output\n"); // uncommitted -> tree kept
      return { output: streamInit("s-impl", "done") };
    });
    const first = await runPlan(p, SCHED_CFG, makeIo(spawn));
    equal(first.worktreesKept.length, 1);
    writeFileSync(join(wtPath, "sentinel.txt"), "still here\n");

    let prepareCalls = 0;
    const worktreeSpy = { ...defaultWorktree, prepareIsolation: (...a) => { prepareCalls++; return defaultWorktree.prepareIsolation(...a); } };
    const spawn2 = fakeSpawnFactory((call) => {
      equal(call.opts.cwd, wtPath, "the ask spawns inside the kept worktree");
      return { output: STREAM };
    });
    const io2 = makeIo(spawn2, { worktree: worktreeSpy });
    const r = await runPlan(p, SCHED_CFG, io2, { ask: { taskId: "impl", question: "?" } });

    equal(spawn2.calls.length, 1, "the ask actually dispatched");
    equal(r.summary.tasks.find((t) => t.id === "impl").state, "ok");
    equal(prepareCalls, 0, "the ask never calls prepareIsolation");
    ok(existsSync(join(wtPath, "sentinel.txt")), "the file written before the ask survives");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wtPath], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Q8: ask preserves the prior summary and status for every other task, including worktreesKept", async () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-ask-repo-"));
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-wt3-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  const wtPath = join(dir, "run", "wt-wt");
  try {
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        { id: "wt", prompt: "do wt", model: "haiku", allowedTools: "Read,Edit,Bash", cwd: repo, originalCwd: repo, scratchRedirect: false, isolation: "worktree", timeoutMs: 5000, after: [] },
        schedTask("b"),
        schedTask("c"),
      ],
    };
    const spawn = fakeSpawnFactory((call) => {
      const m = promptOf(call)?.match(/^do (.+)/);
      const id = m ? m[1] : "unknown";
      if (id === "wt") writeFileSync(join(call.opts.cwd, "made-by-leaf.txt"), "output\n"); // uncommitted -> tree kept
      return { output: streamInit(`s-${id}`, `output for ${id}`) };
    });
    await runPlan(p, SCHED_CFG, makeIo(spawn));

    const beforeSummary = JSON.parse(readFileSync(join(p.resultsDir, "summary.json"), "utf8"));
    equal(beforeSummary.worktreesKept.length, 1);
    const beforeWt = beforeSummary.tasks.find((t) => t.id === "wt");
    const beforeC = beforeSummary.tasks.find((t) => t.id === "c");
    const beforeStatus = readRun(p.resultsDir);
    const beforeStatusWt = beforeStatus.tasks.find((t) => t.id === "wt");
    const beforeStatusC = beforeStatus.tasks.find((t) => t.id === "c");

    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "b", question: "?" } });

    equal(JSON.stringify(r.summary.worktreesKept), JSON.stringify(beforeSummary.worktreesKept));
    equal(JSON.stringify(r.summary.tasks.find((t) => t.id === "wt")), JSON.stringify(beforeWt));
    equal(JSON.stringify(r.summary.tasks.find((t) => t.id === "c")), JSON.stringify(beforeC));

    const afterStatus = readRun(p.resultsDir);
    const afterStatusWt = afterStatus.tasks.find((t) => t.id === "wt");
    const afterStatusC = afterStatus.tasks.find((t) => t.id === "c");
    equal(afterStatusWt.state, beforeStatusWt.state);
    equal(afterStatusWt.durationMs, beforeStatusWt.durationMs);
    equal(afterStatusC.state, beforeStatusC.state);
    equal(afterStatusC.durationMs, beforeStatusC.durationMs);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wtPath], { cwd: repo, windowsHide: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Q10: a second ask on the same leaf APPENDS to asks[], leaving the first entry and the leaf's output intact", async () => {
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    const before = readResult(p.resultsDir, "a");
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "first?" } });
    const afterFirst = readResult(p.resultsDir, "a");
    equal(afterFirst.asks.length, 1);

    const secondStream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-3" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "the second answer", usage: { input_tokens: 20, output_tokens: 10 } }),
    ].join("\n") + "\n";
    const spawn3 = fakeSpawnFactory(() => ({ output: secondStream }));
    await runPlan(p, SCHED_CFG, makeIo(spawn3), { ask: { taskId: "a", question: "second?" } });
    const afterSecond = readResult(p.resultsDir, "a");

    equal(afterSecond.asks.length, 2);
    equal(afterSecond.asks[0].question, "first?");
    equal(afterSecond.asks[0].answer, afterFirst.asks[0].answer);
    equal(afterSecond.asks[1].question, "second?");
    equal(afterSecond.asks[1].answer, "the second answer");
    equal(afterSecond.output, before.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q7: a failed ask leaves the leaf ok, records the failure in asks[]", async () => {
  const { dir, plan: p } = await finishedRun([schedTask("a")]);
  try {
    const spawn2 = fakeSpawnFactory(() => ({ exit: 1, output: "No conversation found with session ID s-a" }));
    const r = await runPlan(p, SCHED_CFG, makeIo(spawn2), { ask: { taskId: "a", question: "?" } });
    equal(r.summary.tasks.find((t) => t.id === "a").state, "ok");
    const after = readResult(p.resultsDir, "a");
    equal(after.ok, true);
    equal(after.asks[0].ok, false);
    ok(after.asks[0].answer.includes("No conversation found"), after.asks[0].answer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
