import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { runPlan } from "../src/scheduler.mjs";
import { treeDirFor } from "../src/worktree.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo, promptOf } from "./helpers/scheduler-fixtures.mjs";

// The add is a child process the launch awaits, so a slow one holds up nothing else.
test("a held-open worktree add does not freeze another leaf or a stop request", { timeout: 20000 }, async () => {
  const dir = tmp();
  try {
    let release;
    const held = new Promise((resume) => { release = resume; });
    let slowSettled = false;
    let fastSettledWhileHeld = false;
    const io = makeIo(fakeSpawnFactory((call) => {
      if (promptOf(call) === "do fast" && !slowSettled) fastSettledWhileHeld = true;
      return { output: "done" };
    }), {
      worktree: {
        prepareIsolation: async (t, cfg, resultsDir) => {
          if (t.id === "slow") { await held; slowSettled = true; }
          return { path: treeDirFor(resultsDir, t.id, CFG), branch: `swarm/${t.id}`, name: t.id, head: "h", repo: resultsDir, reused: false };
        },
        collect: (t, cfg, wt) => ({ kept: true, branch: wt.branch, path: wt.path, diffstat: "d" }),
      },
    });
    const p = plan(dir, [
      task("slow", { worktreeName: "slow", allowedTools: "Read,Edit,Bash", cwd: dir, checkoutToplevel: dir }),
      task("fast", { worktreeName: "fast", allowedTools: "Read,Edit,Bash", cwd: dir, checkoutToplevel: dir }),
    ], { concurrency: 2 });
    const runPromise = runPlan(p, CFG, io);
    // Wait for the other leaf to settle while the first add is still held open.
    await new Promise((resume) => {
      const poll = setInterval(() => {
        if (readResult(p.resultsDir, "fast")) { clearInterval(poll); resume(); }
      }, 10);
      setTimeout(() => { clearInterval(poll); resume(); }, 5000);
    });
    ok(fastSettledWhileHeld, "another leaf's callback ran while one add was held open");
    equal(readResult(p.resultsDir, "fast")?.ok, true, "the free leaf settled ok");

    process.emit("SIGINT");
    release();
    const r = await runPromise;
    equal(r.summary.stopped, true, "a stop request landed while the add was still held");
    equal(r.summary.tasks.find((t) => t.id === "fast").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stop sweep kills the children that exist; a leaf still waiting on its tree has
// none, so nothing else would stop it reaching its provider.
test("a leaf still waiting on its tree never reaches its provider after a stop", { timeout: 20000 }, async () => {
  const dir = tmp();
  try {
    let release;
    let reached;
    const held = new Promise((resume) => { release = resume; });
    const atAdd = new Promise((resume) => { reached = resume; });
    const spawned = [];
    const io = makeIo(fakeSpawnFactory((call) => {
      spawned.push(promptOf(call));
      return { output: "done" };
    }), {
      worktree: {
        prepareIsolation: async (t, cfg, resultsDir) => {
          reached();
          await held;
          return { path: treeDirFor(resultsDir, t.id, CFG), branch: `swarm/${t.id}`, name: t.id, head: "h", repo: resultsDir, reused: false };
        },
        collect: (t, cfg, wt) => ({ kept: true, branch: wt.branch, path: wt.path, diffstat: "d" }),
      },
    });
    const p = plan(dir, [
      task("slow", { worktreeName: "slow", allowedTools: "Read,Edit,Bash", cwd: dir, checkoutToplevel: dir }),
    ], { concurrency: 1 });
    const runPromise = runPlan(p, CFG, io);
    await atAdd;
    process.emit("SIGINT");
    release();
    const r = await runPromise;

    equal(spawned.includes("do slow"), false, "no provider was launched after the stop");
    equal(r.summary.tasks.find((t) => t.id === "slow").state, "failed:stopped", "the leaf is recorded stopped, not run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
