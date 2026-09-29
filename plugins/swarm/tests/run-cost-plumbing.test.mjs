// `numTurns` is a `:cloud` leaf's request count, and so the input to its `% of week` figure.
// Every reader that later prices a leaf builds its row from something the engine wrote, so
// each one has to be handed the count: the summary row, the run.log task-done event and
// `readRun`, the live roster, the re-ask sum, and the ask entry.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runPlan } from "../src/scheduler.mjs";
import { readRun, readRunLog } from "../src/runlog.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo, sentPrompt } from "./helpers/scheduler-fixtures.mjs";
import { runCli, runValidated } from "./helpers/cli.mjs";
import { writeFileSync } from "node:fs";
import { tmp as gitTmp } from "./helpers/cli-fixture.mjs";

const SITES = { type: "object", required: ["sites"], properties: { sites: { type: "array" } } };
const turnsStream = (text, sid, turns, usage = { input_tokens: 100, output_tokens: 10 }) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: sid }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage, num_turns: turns }),
].join("\n") + "\n";
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function withRun(tasks, respond, { cfg = CFG, planOver = {} } = {}, fn) {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(respond);
    const io = makeIo(spawn);
    const p = plan(dir, tasks, planOver);
    const r = await runPlan(p, cfg, io);
    return await fn({ p, r, io });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("numTurns reaches the summary row, the run.log task-done event and readRun's row", () =>
  withRun([task("a")], () => ({ output: turnsStream("done", "s-1", 5) }), {}, ({ p, r }) => {
    equal(r.summary.tasks.find((t) => t.id === "a").numTurns, 5, "summary row");
    const events = readFileSync(join(p.resultsDir, "run.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    equal(events.find((e) => e.id === "a" && e.state === "ok").numTurns, 5, "run.log task-done event");
    equal(readRun(p.resultsDir).tasks.find((t) => t.id === "a").numTurns, 5, "readRun row");
  }));

test("a leaf that reports no turn count leaves every reader's numTurns absent", () =>
  withRun([task("a")], () => ({ output: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x", usage: { input_tokens: 1, output_tokens: 1 } }) + "\n" }), {}, ({ p, r }) => {
    ok(!("numTurns" in r.summary.tasks.find((t) => t.id === "a")));
    equal(readRun(p.resultsDir).tasks.find((t) => t.id === "a").numTurns, undefined);
  }));

test("re-asks sum their turns with the first attempt's, so each is counted as a request", () => {
  let call = 0;
  return withRun([task("a", { returns: SITES })], (c) => {
    call += 1;
    return sentPrompt(c).includes("did not match") ? { output: turnsStream(JSON.stringify({ sites: [1] }), "s-2", 3) } : { output: turnsStream("prose", "s-1", 5) };
  }, {}, ({ p, r }) => {
    equal(call, 2);
    equal(readResult(p.resultsDir, "a").numTurns, 8, "result file");
    equal(r.summary.tasks.find((t) => t.id === "a").numTurns, 8, "summary row");
  });
});

test("the live roster prices from the turns and tokens the engine holds, beside the work tokens", () =>
  withRun([task("a")], () => ({ output: turnsStream("done", "s-1", 5, { input_tokens: 1_000_000, output_tokens: 100_000 }) }), { cfg: { ...CFG, display: { money: true } } }, ({ io }) => {
    const last = plain(io.snapshots[io.snapshots.length - 1]);
    ok(/tokens · ≈\$[\d.]+ api-eq/.test(last), last);
  }));

test("the live roster prints no dollar sign by default", () =>
  withRun([task("a")], () => ({ output: turnsStream("done", "s-1", 5, { input_tokens: 1_000_000, output_tokens: 100_000 }) }), {}, ({ io }) => {
    ok(io.snapshots.length > 0);
    ok(!io.snapshots.some((s) => s.includes("$")));
  }));

test("swarm ask: the ask entry carries its own turns, and the summary row sums them with the original leaf's", () => {
  const dir = gitTmp();
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({ resultsDir: "out", tasks: [{ id: "t1", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    const env = { SWARM_HOME: join(dir, "home"), SWARM_SHIM_STREAM: "1", SWARM_SHIM_OUTPUT: "because X" };
    equal(runValidated(["run", manifest], { cwd: dir, env }).status, 0);
    const before = JSON.parse(readFileSync(join(dir, "out", "summary.json"), "utf8")).tasks[0];
    equal(before.numTurns, 1, "the shim reports one turn");
    equal(runCli(["ask", join(dir, "out"), "t1", "why?"], { cwd: dir, env }).status, 0);
    const res = JSON.parse(readFileSync(join(dir, "out", "results", "t1.json"), "utf8"));
    equal(res.asks[res.asks.length - 1].numTurns, 1, "the ask entry");
    const after = JSON.parse(readFileSync(join(dir, "out", "summary.json"), "utf8")).tasks[0];
    equal(after.numTurns, 2, "summed with the tokens it is priced beside");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate-limited attempt's turns count toward the leaf's requests", () => {
  let calls = 0;
  const limited = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "429 rate limit", num_turns: 2 }) + "\n";
  return withRun([task("a")], () => (++calls === 1 ? { exit: 1, output: limited } : { output: turnsStream("done", "s-1", 3) }),
    { cfg: { ...CFG, retry: { rateLimited: 2, backoffMs: 10 } } }, ({ r }) => {
      equal(calls, 2);
      equal(r.summary.tasks.find((t) => t.id === "a").numTurns, 5, "both attempts' requests");
    });
});

test("a cache-replayed leaf keeps its recorded turns on the summary row", () =>
  withRun([task("a")], () => ({ output: turnsStream("done", "s-1", 4) }), {}, async ({ p }) => {
    const spawn = fakeSpawnFactory(() => ({ output: "should not run" }));
    const again = await runPlan(p, CFG, makeIo(spawn));
    equal(spawn.calls.length, 0);
    equal(again.summary.tasks.find((t) => t.id === "a").numTurns, 4);
  }));

test("a run-start resets the turn counts it read from an earlier attempt", () => {
  const ev = (o) => JSON.stringify({ ts: "2026-09-29T00:00:00Z", ...o });
  const log = [
    ev({ event: "run-start", tasks: ["a"] }),
    ev({ id: "a", state: "ok", numTurns: 5 }),
    ev({ event: "run-start", tasks: ["a"] }),
  ].join("\n") + "\n";
  equal(readRunLog(log).tasks.find((t) => t.id === "a").numTurns, undefined);
});
