import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { runPlan, runTask } from "../src/scheduler.mjs";
// The stall seams are internal to the scheduler, not part of its public surface
// (tests/module-surface.test.mjs pins that to the pre-split names).
import { loopStallMs, nextStallCredit } from "../src/scheduler/loop-stall.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo, promptOf, streamOut } from "./helpers/scheduler-fixtures.mjs";

// A synchronous spin long enough for the monitor to notice the loop was blocked.
function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* intentional */ }
}

test("row 5: the ready loop yields a macrotask between leaf launches", async () => {
  const dir = tmp();
  try {
    const order = [];
    const spawn = fakeSpawnFactory((call) => {
      const id = promptOf(call).slice(3);
      order.push(`spawn-${id}`);
      // The callback a running leaf arms at spawn. Blocking the loop past it is what
      // starved a live clone's own close and timed the leaf out.
      if (id === "a") setImmediate(() => order.push("macrotask-a"));
      return { output: streamOut(`done-${id}`, `s-${id}`), delayMs: 1 };
    });
    const r = await runPlan(plan(dir, [task("a"), task("b")]), CFG, makeIo(spawn));

    equal(r.summary.tasks.find((t) => t.id === "a").state, "ok");
    equal(r.summary.tasks.find((t) => t.id === "b").state, "ok");
    const macrotask = order.indexOf("macrotask-a");
    ok(macrotask >= 0, `the leaf's queued macrotask never ran: ${order.join(",")}`);
    ok(macrotask < order.indexOf("spawn-b"),
      `the second seat launched before the first leaf's macrotask ran: ${order.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 5(b): a stop landing inside the yield never launches the remaining seats", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const id = promptOf(call).slice(3);
      // requestStop kills only the children that exist at that instant, so a seat
      // launched after the stop would escape it.
      if (id === "a") process.emit("SIGINT");
      return { output: streamOut(`done-${id}`, `s-${id}`), delayMs: 1 };
    });
    const r = await runPlan(plan(dir, [task("a"), task("b")]), CFG, makeIo(spawn));

    equal(spawn.calls.length, 1, `a seat launched after the stop: ${spawn.calls.map(promptOf).join(",")}`);
    equal(r.summary.tasks.find((t) => t.id === "b").state, "failed:stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 6a: a 600 ms synchronous busy-wait raises the stall reading", async () => {
  const before = loopStallMs();
  busyWait(600);
  // A timer turn lets the monitor's tick bank the stall, so the read below comes off
  // the accumulated total rather than the stall still in progress.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const banked = loopStallMs();
  ok(banked - before >= 350,
    `a 600 ms stall moved the reading by ${banked - before} ms (want >= 350 ms)`);
  // Banked, not still in progress: a quiet stretch must not move it again. A reading
  // that only ever counted the stall in progress would climb with the wall clock.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const quiet = loopStallMs();
  ok(quiet - banked < 500,
    `the reading grew ${quiet - banked} ms across a quiet loop — the stall was never banked`);
});

test("row 6b: a stall still in progress is counted before the monitor's next tick", () => {
  const before = loopStallMs();
  busyWait(600);
  // No turn between the spin and this read, so no interval tick has fired: anything
  // counted here is the stall still in progress.
  const during = loopStallMs();
  ok(during - before >= 350,
    `the in-progress stall was not counted: the reading moved ${during - before} ms`);
});

test("row 6c: a budget that elapsed during a stall re-arms instead of timing out", () => {
  const step = nextStallCredit({ stallMs: 5000, chargedMs: 0, creditMs: 0, timeoutMs: 1000 });
  equal(step.extra, 1000, "the leaf is re-armed for the stall it was charged for");
});

// The same decision as the timer actually runs it. A blocked loop queues the leaf's
// exit behind the expired budget timer, so the re-arm decides whether the exit or the
// kill wins — an ordering the loop phases settle, not a wall-clock margin.
test("row 6c (wiring): a leaf whose budget elapsed during a stall is not killed", { timeout: 20000 }, async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  const io = {
    spawn: () => {
      setTimeout(() => {
        busyWait(1300);
        // Armed after the spin, so it lands in the next timers phase behind the budget
        // timer that expired during it: the re-arm decides which of the two wins.
        setTimeout(() => { child.emit("exit", 0); child.emit("close", 0); }, 0);
      }, 50);
      return child;
    },
    fetch: async () => ({ ok: true }),
    now: () => Date.now(),
    freeMemMb: () => Infinity,
    stdout: () => {}, snapshot: () => {}, maxLines: 0, env: process.env,
    exitDrainMs: 10,
    killTree: () => { killed = true; },
  };
  // runTask unrefs its timers, and this fake child holds no handle of its own.
  const keep = setInterval(() => {}, 1000);
  try {
    const result = await runTask(task("stall-rearm", { timeoutMs: 1200 }), "go", CFG, io, null, {});
    equal(result.timedOut, false, "a leaf held up by the engine must not be timed out for it");
    equal(result.ok, true);
    equal(killed, false, "the budget's kill must not fire for time the engine was blocked");
  } finally {
    clearInterval(keep);
  }
});

test("row 6d: with no stall the leaf times out on its budget", () => {
  const step = nextStallCredit({ stallMs: 0, chargedMs: 0, creditMs: 0, timeoutMs: 1000 });
  equal(step.extra, 0, "a live loop means the budget is the leaf's own");
});

test("row 6f: the re-arm never credits a stall twice, so a quiet loop still ends a hung leaf", () => {
  const first = nextStallCredit({ stallMs: 500, chargedMs: 0, creditMs: 0, timeoutMs: 1000 });
  equal(first.extra, 500);
  const second = nextStallCredit({
    stallMs: 500, chargedMs: first.chargedMs, creditMs: first.creditMs, timeoutMs: 1000,
  });
  equal(second.extra, 0, "the stall already credited is not credited again — the leaf dies one budget after it");
});

test("row 6g: stalls beyond the budget stop crediting at one budget", () => {
  const first = nextStallCredit({ stallMs: 5000, chargedMs: 0, creditMs: 0, timeoutMs: 1000 });
  equal(first.extra, 1000, "credit is capped at one budget");
  equal(first.creditMs, 1000);
  const second = nextStallCredit({
    stallMs: 8000, chargedMs: first.chargedMs, creditMs: first.creditMs, timeoutMs: 1000,
  });
  equal(second.extra, 0, "an engine-wide stall must not extend a hung leaf without limit");
});
