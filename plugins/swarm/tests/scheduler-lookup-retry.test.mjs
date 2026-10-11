import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { rmSync } from "node:fs";
import { runPlan } from "../src/scheduler.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo } from "./helpers/scheduler-fixtures.mjs";

test("governance lookup failure retries with bounded backoff, then keeps the git error", async () => {
  const dir = tmp();
  try {
    const base = defaultProviderRegistry();
    let lookupFailures = 0;
    const providerRegistry = new Proxy(base, {
      get(target, key) {
        if (key === "resolve") return (...args) => {
          const identity = target.resolve(...args);
          if (new Error().stack.includes("dispatch.mjs")) {
            lookupFailures++;
            const error = new Error("git repo lookup failed: spawn EAGAIN");
            error.code = "GOVERNANCE_LOOKUP_FAILED";
            throw error;
          }
          return identity;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const spawn = fakeSpawnFactory(() => ({ output: "unexpected dispatch" }));
    const p = plan(dir, [task("lookup", { cwd: dir })]);
    const r = await runPlan(p, { ...CFG, retry: { lookupFailed: 2, spawnError: 0, backoffMs: 5 } }, makeIo(spawn), { providerRegistry });
    equal(lookupFailures, 3, "the configured budget permits two retries after the first lookup failure");
    equal(spawn.calls.length, 0, "the failed governance lookup never invokes a provider runner");
    equal(r.summary.tasks[0].state, "failed");
    const result = readResult(p.resultsDir, "lookup");
    ok(result.output.includes("git repo lookup failed"), result.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
