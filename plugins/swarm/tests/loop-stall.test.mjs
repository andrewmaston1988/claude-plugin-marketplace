import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { runPlan, loopStallMs, nextStallCredit } from "../src/scheduler.mjs";
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

test("row 6a: a 600 ms synchronous busy-wait raises the stall reading", () => {
  const before = loopStallMs();
  busyWait(600);
  const after = loopStallMs();
  ok(after - before >= 350,
    `a 600 ms stall moved the reading by ${after - before} ms (want >= 350 ms)`);
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
