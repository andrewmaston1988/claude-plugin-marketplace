// A resume preflights a provider only when a leaf seated on it will dispatch: a
// leaf whose saved result reusable() accepts never feeds the provider groups.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan } from "../src/scheduler.mjs";
import { createProviderRegistry } from "../src/providers.mjs";
import { createCodexProviderAdapter } from "../src/codex.mjs";
import { initResultsDir } from "../src/results.mjs";
import { writeTaskResult } from "../src/task-key.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const CFG = {
  providers: { codex: { enabled: true } },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-resume-preflight-"));
}

function leaf(id, dir, over = {}) {
  return {
    id, prompt: `do ${id}`, provider: "codex", model: "gpt-5-codex",
    allowedTools: "Read", cwd: dir, originalCwd: dir, timeoutMs: 5000, after: [], ...over,
  };
}

function saved(plan, task, over = {}) {
  initResultsDir(plan.resultsDir);
  writeTaskResult(plan.resultsDir, task, { ok: true, output: "done", durationMs: 1, tokens: null, ...over });
}

// Codex with its preflight swapped for a counting spy that can be told to fail.
function setUp(dir, { healthy = true } = {}) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
  const io = makeIo(spawn, { env: { PATH: process.env.PATH, SWARM_HOME: home } });
  const base = createCodexProviderAdapter();
  const calls = [];
  const adapter = {
    ...base,
    capabilities: {
      ...base.capabilities,
      preflight: async (ctx) => { calls.push(ctx.tasks.map((t) => t.id)); return healthy ? { ok: true } : { ok: false, error: "down" }; },
    },
  };
  return { io, spawn, calls, providerRegistry: createProviderRegistry([adapter]) };
}

const planOf = (dir, tasks) => ({ cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "" });
const cfgFor = (dir) => ({ ...CFG, allowedRoots: [dir] });

test("1: a resume whose leaves on a provider are all reusable skips its preflight", async () => {
  const dir = tmp();
  try {
    const { io, spawn, calls, providerRegistry } = setUp(dir);
    const a = leaf("a", dir);
    const plan = planOf(dir, [a]);
    saved(plan, a);
    const { summary } = await runPlan(plan, cfgFor(dir), io, { providerRegistry });
    equal(calls.length, 0, "no preflight for a provider with nothing to dispatch");
    equal(spawn.calls.length, 0);
    ok(summary);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("2: a failing preflight does not abort a resume that has nothing to dispatch there", async () => {
  const dir = tmp();
  try {
    const { io, spawn, calls, providerRegistry } = setUp(dir, { healthy: false });
    const a = leaf("a", dir);
    const plan = planOf(dir, [a]);
    saved(plan, a);
    await runPlan(plan, cfgFor(dir), io, { providerRegistry });
    equal(calls.length, 0);
    equal(spawn.calls.length, 0, "the reusable leaf is skipped, not re-run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("3: one non-reusable leaf keeps the preflight, and a failing one still aborts", async () => {
  const dir = tmp();
  try {
    const { io, calls, providerRegistry } = setUp(dir, { healthy: false });
    const a = leaf("a", dir);
    const b = leaf("b", dir);
    const plan = planOf(dir, [a, b]);
    saved(plan, a);
    await rejects(() => runPlan(plan, cfgFor(dir), io, { providerRegistry }), /preflight failed/);
    equal(calls.length, 1);
    equal(calls[0].join(","), "b", "only the leaf that will dispatch is in the group");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("4: a leaf whose saved key mismatches counts as dispatching", async () => {
  const dir = tmp();
  try {
    const { io, calls, providerRegistry } = setUp(dir, { healthy: false });
    const plan = planOf(dir, [leaf("a", dir, { prompt: "edited" })]);
    saved(plan, leaf("a", dir));
    await rejects(() => runPlan(plan, cfgFor(dir), io, { providerRegistry }), /preflight failed/);
    equal(calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("5: a fresh run preflights every provider seated by any leaf", async () => {
  const dir = tmp();
  try {
    const { io, calls, providerRegistry } = setUp(dir);
    await runPlan(planOf(dir, [leaf("a", dir), leaf("b", dir)]), cfgFor(dir), io, { providerRegistry });
    equal(calls.length, 1);
    equal(calls[0].join(","), "a,b");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("6: a composed child with a reusable result is left out of its provider's group", async () => {
  const dir = tmp();
  try {
    const { io, calls, providerRegistry } = setUp(dir, { healthy: false });
    const child = leaf("c", dir);
    const node = { id: "n", prompt: "", model: "manifest", cwd: dir, after: [], timeoutMs: 5000, childPlan: { tasks: [child] } };
    const plan = planOf(dir, [node]);
    saved(plan, { ...child, id: "n~c" });
    await runPlan(plan, cfgFor(dir), io, { providerRegistry }).catch((e) => {
      ok(!/preflight failed/.test(e.message), e.message);
    });
    equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
