// A billed leaf's run behaviour: what its result records, how its failures are
// classified, and which leaves a quota death sweeps. Split from
// scheduler-dispatch.test.mjs, which is over the 500-line bar and may not grow.
import { test } from "node:test";
import { equal, rejects } from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, childPlanOf, fakeSpawnFactory, makeIo, promptOf, streamOut } from "./helpers/scheduler-fixtures.mjs";

const KEY_VAR = "SWARM_ANTHROPIC_API_KEY";

// io.env is what the preflight and the spawn read, so a billed leaf's key rides in
// through it — never through the process environment a test shares with others.
const billedIo = (spawn, over = {}) => makeIo(spawn, {
  env: { PATH: process.env.PATH, SWARM_HOME: mkdtempSync(join(tmpdir(), "swarm-billing-")), [KEY_VAR]: "sk-test" },
  ...over,
});

const billedTask = (id, dir, over = {}) => task(id, {
  provider: "claude", model: "claude-sonnet-5", cwd: dir, originalCwd: dir, billing: "api", ...over,
});

test("billing: launch records result.billing", async () => {
  const dir = tmp();
  try {
    const io = billedIo(fakeSpawnFactory(() => ({ output: streamOut("ok", "s-b") })));
    const p = plan(dir, [billedTask("b", dir)]);
    await runPlan(p, CFG, io);
    equal(readResult(p.resultsDir, "b").billing, "api");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The only evidence of which credential a leaf actually spent.
test("billing: launch records result.apiKeySource from the stream", async () => {
  const dir = tmp();
  try {
    const io = billedIo(fakeSpawnFactory(() => ({
      output: streamOut("ok", "s-b", undefined, 0.01, "ANTHROPIC_API_KEY"),
    })));
    const p = plan(dir, [billedTask("b", dir)]);
    await runPlan(p, CFG, io);
    equal(readResult(p.resultsDir, "b").apiKeySource, "ANTHROPIC_API_KEY");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Preflight sees the manifest's children, so a billed child is checked even
// though its node is agentless and runs nothing itself.
test("billing: the key check covers a billed child of a manifest node", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("ok", "s-scan") }));
    const io = makeIo(spawn); // no key var
    const node = task("audit", {
      model: "manifest", prompt: "", cwd: dir, originalCwd: dir,
      childPlan: childPlanOf(billedTask("scan", dir)),
    });
    await rejects(
      () => runPlan(plan(dir, [node]), CFG, io),
      (error) => error.message.includes(KEY_VAR) && error.message.includes("scan"),
    );
    equal(spawn.calls.length, 0, "a keyless billed child must not reach a spawn");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("billing: a spent balance on a billed leaf classifies quota", async () => {
  const dir = tmp();
  try {
    const io = billedIo(fakeSpawnFactory(() => ({
      exit: 1, output: "Your credit balance is too low to access the Anthropic API.",
    })));
    const p = plan(dir, [billedTask("b", dir)]);
    const r = await runPlan(p, CFG, io);
    equal(readResult(p.resultsDir, "b").failureClass, "quota");
    equal(r.summary.tasks[0].state, "quota");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// RED (revert): add the credit pattern to PROVIDER_QUOTA_PATTERNS and this row
// reddens — the subscription lane must never read spent credit as its own limit.
test("billing: the same text does not classify quota for a subscription leaf", async () => {
  const dir = tmp();
  try {
    const io = billedIo(fakeSpawnFactory(() => ({
      exit: 1, output: "Your credit balance is too low to access the Anthropic API.",
    })));
    const p = plan(dir, [task("sub", { cwd: dir, originalCwd: dir })]);
    const r = await runPlan(p, CFG, io);
    equal(readResult(p.resultsDir, "sub").failureClass, undefined);
    equal(r.summary.tasks[0].state, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// One spent balance grounds the other leaves drawing on it, and not the ones
// drawing on the subscription.
test("billing: a billed leaf's quota failure sweeps pending billed leaves only", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => (promptOf(call) === "do b1"
      ? { exit: 1, output: "Your credit balance is too low to access the Anthropic API." }
      : { output: streamOut("ok", "s-x") }));
    const io = billedIo(spawn);
    const p = plan(dir, [billedTask("b1", dir), billedTask("b2", dir), task("sub", { cwd: dir, originalCwd: dir })], { concurrency: 1 });
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.b1, "quota");
    equal(states.b2, "quota", "the other billed leaf draws on the same balance");
    equal(states.sub, "ok", "a subscription leaf is not grounded by a spent balance");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("billing: a subscription leaf's quota failure sweeps no billed leaf", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => (promptOf(call) === "do sub"
      ? { exit: 1, output: "usage limit reached — resets at 3pm" }
      : { output: streamOut("ok", "s-b") }));
    const io = billedIo(spawn);
    const p = plan(dir, [task("sub", { cwd: dir, originalCwd: dir }), billedTask("b", dir)], { concurrency: 1 });
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.sub, "quota");
    equal(states.b, "ok", "an exhausted allowance does not ground a leaf that spends credit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
