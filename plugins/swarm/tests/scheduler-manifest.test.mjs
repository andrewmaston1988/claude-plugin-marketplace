import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
test("manifest node: children run namespaced, sinks aggregate as the node's output, dependents inline it", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const prompt = promptOf(call);
      if (prompt === "scan things") return { output: streamOut(JSON.stringify({ found: 2 }), "s-scan") };
      if (prompt.startsWith("sum")) return { output: streamOut("two things", "s-sum") };
      return { output: streamOut(`final saw: ${prompt.split("|")[1]}`, "s-final") };
    });
    const io = makeIo(spawn);
    const node = task("audit", {
      model: "manifest", prompt: "",
      childPlan: childPlanOf(
        task("scan", { prompt: "scan things" }),
        task("sum", { prompt: "sum {{result:scan}}", after: ["scan"] }),
      ),
    });
    const p = plan(dir, [node, task("final", { prompt: "final|{{result:audit}}", after: ["audit"] })]);
    await runPlan(p, CFG, io);

    equal(readResult(p.resultsDir, "audit~scan").ok, true);
    equal(readResult(p.resultsDir, "audit~sum").ok, true);
    // within-child {{result:}} resolved to the namespaced id
    const sumCall = spawn.calls.find((c) => promptOf(c).startsWith("sum"));
    ok(promptOf(sumCall).includes(JSON.stringify({ found: 2 })), promptOf(sumCall));
    // the node aggregates its sinks: only 'sum' has no within-child dependents
    const agg = readResult(p.resultsDir, "audit");
    equal(agg.ok, true);
    deepEqual(agg.outputJson, { sum: "two things" });
    // and the dependent's template inlined it
    const finalRes = readResult(p.resultsDir, "final");
    ok(finalRes.output.includes('"sum":"two things"'), finalRes.output);

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expand = logLines.find((l) => l.event === "expand-manifest");
    deepEqual(expand.children, [{ id: "audit~scan", provider: "claude", runner: "claude", model: "claude-haiku-4-5-20251001" }, { id: "audit~sum", provider: "claude", runner: "claude", model: "claude-haiku-4-5-20251001" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach × child: per-item child copies with {{item}} substituted; one item's failure dooms only the node", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const prompt = promptOf(call);
      if (prompt === "do seed") return { output: streamOut(JSON.stringify(["alpha", "beta"]), "s-seed") };
      if (prompt === "ask alpha") return { output: streamOut("", "s-a0"), exit: 1 }; // alpha's scan fails
      if (prompt === "ask beta") return { output: streamOut("beta says hi", "s-b0") };
      return { output: streamOut(`condensed: ${prompt}`, "s-x") };
    });
    const io = makeIo(spawn);
    const node = task("audit", {
      model: "manifest", prompt: "", after: ["seed"],
      forEach: { from: "seed", path: "", maxItems: 5 },
      childPlan: childPlanOf(
        task("ask", { prompt: "ask {{item}}" }),
        task("cut", { prompt: "cut {{result:ask}}", after: ["ask"] }),
      ),
    });
    const p = plan(dir, [task("seed"), node]);
    await runPlan(p, CFG, io);

    // beta's chain completed
    equal(readResult(p.resultsDir, "audit[1]~ask").ok, true);
    equal(readResult(p.resultsDir, "audit[1]~cut").ok, true);
    // alpha's scan failed -> alpha's cut blocked -> the audit aggregate is doomed
    equal(readResult(p.resultsDir, "audit[0]~ask").ok, false);
    equal(readResult(p.resultsDir, "audit[0]~cut"), null);
    const summary = JSON.parse(readFileSync(join(p.resultsDir, "summary.json"), "utf8"));
    equal(summary.tasks.find((t) => t.id === "audit[0]~cut").state, "blocked");
    equal(summary.tasks.find((t) => t.id === "audit").state, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child compute reads deps by local id through aliases", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "list"
      ? { output: streamOut(JSON.stringify({ xs: [3, 1, 3] }), "s-l") }
      : { output: streamOut("done", "s-d") });
    const io = makeIo(spawn);
    const node = task("crunch", {
      model: "manifest", prompt: "",
      childPlan: childPlanOf(
        task("get", { prompt: "list" }),
        { id: "dedupe", model: "compute", prompt: "", allowedTools: "", cwd: tmpdir(), originalCwd: tmpdir(), timeoutMs: 5000, after: ["get"], compute: "unique_by(filter(deps['get'].xs, item > 0), '')" },
      ),
    });
    // unique_by needs objects; keep it simple: sum instead
    node.childPlan.tasks[1].compute = "sum(deps['get'].xs)";
    const p = plan(dir, [node]);
    await runPlan(p, CFG, io);
    const agg = readResult(p.resultsDir, "crunch");
    equal(agg.ok, true);
    deepEqual(agg.outputJson, { dedupe: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: prior-ok child tasks skip on re-run", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => ({ output: streamOut(`out: ${promptOf(call)}`, "s") }));
    const io = makeIo(spawn);
    const node = () => task("audit", {
      model: "manifest", prompt: "",
      childPlan: childPlanOf(task("scan", { prompt: "scan" }), task("sum", { prompt: "sum it", after: ["scan"] })),
    });
    const p = plan(dir, [node()]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2);

    const spawn2 = fakeSpawnFactory(() => ({ output: streamOut("should not run", "s2") }));
    const io2 = makeIo(spawn2);
    const p2 = { ...plan(dir, [node()]), resultsDir: p.resultsDir };
    await runPlan(p2, CFG, io2);
    equal(spawn2.calls.length, 0); // both children skipped, node re-aggregated
    equal(readResult(p.resultsDir, "audit").ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Live 402 body from ollama for an unfunded extra-usage model.
const ENTITLEMENT_BODY = `{"error":"this model uses extra usage only (not included plan usage) and your extra usage balance is empty, add extra usage or turn on auto reload at https://ollama.com/settings (ref: ...)"}`;

function seedModelsCache(io, models) {
  const p = join(io.env.SWARM_HOME, "models-cache.json");
  writeFileSync(p, JSON.stringify({ updated: "2026-08-09T00:00:00.000Z", models }, null, 2) + "\n");
  return p;
}

test("entitlement failure removes the model from the cache; classification stays failed", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: ENTITLEMENT_BODY }));
    const io = makeIo(spawn);
    const cachePath = seedModelsCache(io, [{ provider: "ollama", model: "kimi-k3:cloud" }, { provider: "ollama", model: "glm-5.2:cloud" }]);
    const r = await runPlan(plan(dir, [task("a", { provider: "ollama", model: "kimi-k3:cloud", cwd: dir })]), CFG, io);
    equal(r.summary.tasks[0].state, "failed"); // not quota, not rate-limited
    deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).models.map((m) => m.model), ["glm-5.2:cloud"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entitlement failure evicts only the failing provider's row of a shared model id", async () => {
  // RED (drop task.provider from the removeCachedModel call): both rows go, and the roster
  // silently loses a model the account is still entitled to run.
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: ENTITLEMENT_BODY }));
    const io = makeIo(spawn);
    const cachePath = seedModelsCache(io, [
      { model: "shared-id:cloud", provider: "ollama" },
      { model: "shared-id:cloud", provider: "codex" },
    ]);
    const r = await runPlan(
      plan(dir, [task("a", { model: "shared-id:cloud", provider: "ollama", cwd: dir })]),
      CFG, io,
    );
    equal(r.summary.tasks[0].state, "failed");
    deepEqual(
      JSON.parse(readFileSync(cachePath, "utf8")).models.map((m) => m.provider),
      ["codex"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary failure leaves the models cache untouched", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "boom" }));
    const io = makeIo(spawn);
    const cachePath = seedModelsCache(io, [{ provider: "ollama", model: "kimi-k3:cloud" }]);
    const before = readFileSync(cachePath, "utf8");
    const r = await runPlan(plan(dir, [task("a", { provider: "ollama", model: "kimi-k3:cloud", cwd: dir })]), CFG, io);
    equal(r.summary.tasks[0].state, "failed");
    equal(readFileSync(cachePath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("success leaves the models cache untouched", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "fine" }));
    const io = makeIo(spawn);
    const cachePath = seedModelsCache(io, [{ provider: "ollama", model: "kimi-k3:cloud" }]);
    const before = readFileSync(cachePath, "utf8");
    const r = await runPlan(plan(dir, [task("a", { provider: "ollama", model: "kimi-k3:cloud", cwd: dir })]), CFG, io);
    equal(r.summary.tasks[0].state, "ok");
    equal(readFileSync(cachePath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
