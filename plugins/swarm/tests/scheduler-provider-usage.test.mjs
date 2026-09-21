// The provider-usage gate's end-to-end rows. Sibling of scheduler.test.mjs,
// which is over the 500-line bar and may not grow.
//
// Defect CS-3 — the gate reads `usage?.exhausted` off the raw adapter reading
// (`scheduler.mjs:539`), and the Codex adapter forwards straight to
// `readCodexUsage`, which returned a snapshot with no such field. `swarm usage`
// showed the truth; the gate read `undefined` and dispatched a leaf into an
// exhausted allowance. Codex has no other gate: its adapter declares no
// preflight and no headroom check, unlike ollama's manifest-side one.
//
// These rows drive the REAL codex adapter and the REAL `readCodexUsage` over a
// fake app-server client, so the contract's `record()` sits in the path — the
// field has to survive it to reach the gate.
import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan } from "../src/scheduler.mjs";
import { createProviderRegistry } from "../src/providers.mjs";
import { createCodexProviderAdapter } from "../src/codex.mjs";
import { CODEX_ACCOUNT_USAGE_METHOD, CODEX_RATE_LIMITS_METHOD } from "../src/codex-usage.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

const CFG = {
  providers: { codex: { enabled: true } },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-provider-usage-"));
}

// A live app-server client whose rate-limit window sits at `usedPercent`.
function codexClient(usedPercent) {
  return {
    async initialize() {},
    async request(method) {
      if (method === CODEX_RATE_LIMITS_METHOD) {
        return { rateLimitsByLimitId: { session: { primary: { usedPercent } } } };
      }
      if (method === CODEX_ACCOUNT_USAGE_METHOD) return { summary: { inputTokens: 10 } };
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function codexTask(id, dir, over = {}) {
  return {
    id,
    prompt: `do ${id}`,
    provider: "codex",
    model: "gpt-5-codex",
    allowedTools: "Read",
    cwd: dir,
    originalCwd: dir,
    timeoutMs: 5000,
    after: [],
    ...over,
  };
}

function setUp(dir, usedPercent) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
  const io = makeIo(spawn, {
    env: { PATH: process.env.PATH, SWARM_HOME: home },
    codexClient: codexClient(usedPercent),
  });
  const providerRegistry = createProviderRegistry([createCodexProviderAdapter()]);
  return { io, spawn, providerRegistry };
}

function buildPlan(dir, tasks) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "" };
}

// A codex leaf is refused before spawn when its cwd sits outside every allowed
// root, so the root list has to name the temp dir for the run to get as far as
// the dispatch the negative rows assert on.
function cfgFor(dir) {
  return { ...CFG, allowedRoots: [dir] };
}

// The decisive row. It reddens on either half of the defect: an un-widened
// contract strips `exhausted` from the reading, or `combineSnapshots` never
// computes it — the gate then sees `undefined` and dispatches.
test("preflight: an exhausted Codex reading aborts before dispatch", async () => {
  const dir = tmp();
  try {
    const { io, spawn, providerRegistry } = setUp(dir, 100);
    await rejects(
      () => runPlan(buildPlan(dir, [codexTask("c", dir)]), cfgFor(dir), io, { providerRegistry }),
      /usage is exhausted/,
    );
    equal(spawn.calls.length, 0, "an exhausted provider must not burn a dispatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The negative half of the percent rule: a reading with headroom must not read
// as exhausted merely because it exists.
test("preflight: a Codex reading under its cap does not trip the gate", async () => {
  const dir = tmp();
  try {
    const { io, spawn, providerRegistry } = setUp(dir, 99);
    await runPlan(buildPlan(dir, [codexTask("c", dir)]), cfgFor(dir), io, { providerRegistry })
      .then(() => {}, (error) => {
        ok(!/usage is exhausted/.test(error.message), `headroom must not ground a leaf: ${error.message}`);
      });
    ok(spawn.calls.length > 0, "a leaf with headroom must be dispatched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exemption `scheduler.mjs:539` already states: a leaf carrying its own
// fallback is allowed through an exhausted provider.
test("preflight: an exhausted Codex reading still dispatches a leaf that has a fallback", async () => {
  const dir = tmp();
  try {
    const { io, spawn, providerRegistry } = setUp(dir, 100);
    await runPlan(
      buildPlan(dir, [codexTask("c", dir, { fallbackModel: "gpt-5-codex-mini" })]),
      cfgFor(dir), io, { providerRegistry },
    ).then(() => {}, (error) => {
      ok(!/usage is exhausted/.test(error.message), `a fallback leaf must not be grounded: ${error.message}`);
    });
    ok(spawn.calls.length > 0, "a fallback leaf must be dispatched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
