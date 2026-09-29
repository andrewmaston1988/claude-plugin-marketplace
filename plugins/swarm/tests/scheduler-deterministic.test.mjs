import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir } from "../src/results.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
test("compute: runs inline with zero spawns; result feeds templates and JSON chains", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"a"},{"f":"a"},{"f":"b"}]}' } : { output: "sunk" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      computeTask("dedupe", "unique_by(deps['src'].sites, 'f')", ["src"]),
      task("sink", { prompt: "got {{result:dedupe}}", after: ["dedupe"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + sink; dedupe never spawns
    const dd = readResult(p.resultsDir, "dedupe");
    equal(dd.ok, true);
    deepEqual(dd.outputJson, [{ f: "a" }, { f: "b" }]);
    equal(dd.output, '[{"f":"a"},{"f":"b"}]');
    equal(promptOf(spawn.calls[1]), 'got [{"f":"a"},{"f":"b"}]');
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    deepEqual(states, { src: "ok", dedupe: "ok", sink: "ok" });
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.id === "dedupe" && l.state === "ok"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: a dependency with non-JSON output binds as a raw string", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "ERROR: kaboom" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("src"), computeTask("check", "contains(deps['src'], 'ERROR')", ["src"])]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "check");
    equal(res.ok, true);
    equal(res.outputJson, true);
    equal(res.output, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute failure: teaching message lands in the result and blocks dependents", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      computeTask("dedupe", "length(deps.src.nope)", ["src"]),
      task("child", { after: ["dedupe"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "dedupe");
    equal(res.ok, false);
    ok(res.output.startsWith("compute failed:"), res.output);
    ok(res.output.includes("length("), res.output);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.dedupe, "failed");
    equal(states.child, "blocked");
    deepEqual(r.summary.blocked, ["child"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: false gate skips with a run.log note; dependents treat skipped as satisfied", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("gate", { after: ["src"], when: { from: "src", expr: "length(value.sites) > 2" } }),
      task("child", { after: ["gate"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + child; the gate never spawns
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.gate, "skipped");
    equal(states.child, "ok");
    equal(readResult(p.resultsDir, "gate"), null); // no result file — when re-evaluates on resume
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const skip = logLines.find((l) => l.id === "gate" && l.state === "skipped");
    ok(skip.note.includes("when:"), skip.note);
    ok(skip.note.includes("false"), skip.note);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: true gate dispatches the leaf normally", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1,2,3]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("gate", { after: ["src"], when: { from: "src", expr: "length(value.sites) > 2" } }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2);
    equal(r.summary.tasks.find((t) => t.id === "gate").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: non-boolean and erroring expressions fail the task with the teaching message", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("g1", { after: ["src"], when: { from: "src", expr: "value.sites" } }),
      task("g2", { after: ["src"], when: { from: "src", expr: "length(value.nope) > 0" } }),
    ]);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.g1, "failed");
    equal(states.g2, "failed");
    ok(/true\/false/.test(readResult(p.resultsDir, "g1").output));
    ok(readResult(p.resultsDir, "g2").output.startsWith("when failed:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: expands clones with {{item}}/{{index}}, parent aggregates for dependents (reverse declaration order)", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do src") return { output: '{"sites":[{"f":"a"},{"f":"a"},{"f":"b"}]}' };
      if (pr.startsWith("fix ")) return { output: `done-${pr[4]}` };
      return { output: "sunk" };
    });
    const io = makeIo(spawn);
    // declared sink-first: settles that complete inline (compute, expansion,
    // aggregation) must re-drive the selection loop, not strand the chain
    const p = plan(dir, [
      task("sink", { prompt: "all: {{result:fix}}", after: ["fix"] }),
      task("fix", { after: ["dedupe"], forEach: { from: "dedupe", path: "", maxItems: 5 }, prompt: "fix {{item.f}} #{{index}}" }),
      computeTask("dedupe", "unique_by(deps['src'].sites, 'f')", ["src"]),
      task("src"),
    ]);
    const r = await runPlan(p, CFG, io);
    deepEqual(spawn.calls.map(promptOf), ["do src", "fix a #0", "fix b #1", 'all: ["done-a","done-b"]']);
    equal(readResult(p.resultsDir, "fix[0]").output, "done-a");
    equal(readResult(p.resultsDir, "fix[1]").output, "done-b");
    const parent = readResult(p.resultsDir, "fix");
    equal(parent.ok, true);
    deepEqual(parent.outputJson, ["done-a", "done-b"]);
    equal(parent.clones, 2);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expand = logLines.find((l) => l.event === "expand");
    deepEqual({ id: expand.id, clones: expand.clones, model: expand.model }, { id: "fix", clones: 2, model: "claude-haiku-4-5-20251001" });
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    deepEqual(states, { src: "ok", dedupe: "ok", fix: "ok", "fix[0]": "ok", "fix[1]": "ok", sink: "ok" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: truncation is loud — result field, run.log, stdout warning, summary", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"a"},{"f":"b"},{"f":"c"}]}' } : { output: "x" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 2 }, prompt: "fix {{item.f}}" }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 3); // src + 2 capped clones
    deepEqual(readResult(p.resultsDir, "fix").truncated, { kept: 2, total: 3 });
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const expand = logLines.find((l) => l.event === "expand");
    equal(expand.truncated, true);
    equal(expand.total, 3);
    ok(io.lines.some((l) => l.includes("first 2") && l.includes("3")), io.lines.join("|"));
    deepEqual(r.summary.truncations, [{ kind: "forEach", id: "fix", kept: 2, total: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: an empty source array completes the parent with an empty aggregate", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[]}' } : { output: "sunk" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item}}" }),
      task("sink", { prompt: "all: {{result:fix}}", after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + sink
    const parent = readResult(p.resultsDir, "fix");
    equal(parent.ok, true);
    deepEqual(parent.outputJson, []);
    equal(promptOf(spawn.calls[1]), "all: []");
    equal(r.summary.tasks.find((t) => t.id === "fix").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: a non-array selection fails the parent with a teaching message", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "nope", maxItems: 5 }, prompt: "fix {{item}}" }),
      task("sink", { after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "fix");
    equal(res.ok, false);
    ok(res.output.includes("expected a JSON array"), res.output);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.fix, "failed");
    equal(states.sink, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: a failed clone dooms the parent aggregate; sibling clones still finish", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do src") return { output: '{"sites":[{"f":"a"},{"f":"b"}]}' };
      if (pr === "fix b") return { exit: 1, output: "clone broke" };
      return { output: "ok" };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}" }),
      task("sink", { after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[0]"], "ok");
    equal(states["fix[1]"], "failed");
    equal(states.fix, "blocked");
    equal(states.sink, "blocked");
    equal(readResult(p.resultsDir, "fix"), null); // no aggregate written
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: clones inherit model and fallbackModel; fallback fires per clone", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      call.args[call.args.indexOf("--model") + 1] === "claude-sonnet-5"
        ? { exit: 1, output: "Claude AI usage limit reached|1751210400" }
        : { output: promptOf(call) === "do src" ? '{"sites":[{"f":"a"}]}' : "recovered" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", {
        after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 },
        prompt: "fix {{item.f}}", provider: "claude", model: "claude-sonnet-5", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001",
      }),
    ]);
    const r = await runPlan(p, { ...CFG, retry: { backoffMs: 10 } }, io);
    const cloneCalls = spawn.calls.filter((c) => promptOf(c) === "fix a");
    equal(cloneCalls.length, 2);
    equal(cloneCalls[0].args[cloneCalls[0].args.indexOf("--model") + 1], "claude-sonnet-5");
    equal(cloneCalls[1].args[cloneCalls[1].args.indexOf("--model") + 1], "claude-haiku-4-5-20251001");
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[0]"], "ok");
    equal(states.fix, "ok");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fb = logLines.find((l) => l.event === "fallback");
    equal(fb.id, "fix[0]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: item data containing template syntax stays literal in the clone prompt", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"{{result:src}}"}]}' } : { output: "x" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}" }),
    ]);
    await runPlan(p, CFG, io);
    // the item value must NOT be re-substituted as a template at launch
    equal(promptOf(spawn.calls[1]), "fix {{result:src}}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: resume skips clones with prior ok results", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}" }),
    ]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "src", { id: "src", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: '{"sites":[{"f":"a"},{"f":"b"}]}', outputJson: { sites: [{ f: "a" }, { f: "b" }] } });
    writeResult(p.resultsDir, "fix[0]", { id: "fix[0]", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "prior" });
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1); // only fix[1]
    equal(promptOf(spawn.calls[0]), "fix b");
    deepEqual(readResult(p.resultsDir, "fix").outputJson, ["prior", "fresh"]);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[0]"], "skipped");
    equal(states["fix[1]"], "ok");
    equal(states.fix, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when + forEach: a false gate skips before any expansion", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do src" ? { output: '{"sites":[{"f":"a"}]}' } : { output: "sunk" });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("fix", {
        after: ["src"], when: { from: "src", expr: "length(value.sites) > 9" },
        forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}",
      }),
      task("sink", { prompt: "all: {{result:fix}}", after: ["fix"] }),
    ]);
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // src + sink; no clones
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.fix, "skipped");
    equal(states.sink, "ok");
    ok(!("fix[0]" in states), "no clone rows for a skipped forEach");
    equal(promptOf(spawn.calls[1]), "all: "); // skipped parent inlines empty
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight: compute steps never trigger the provider health check", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"n":1}' }));
    const io = makeIo(spawn, { fetch: async () => { throw new Error("should not be called"); } });
    const p = plan(dir, [task("src"), computeTask("c", "deps['src'].n == 1", ["src"])]);
    const r = await runPlan(p, CFG, io); // must not reject on the health check
    equal(r.summary.tasks.find((t) => t.id === "c").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota fail-fast never dooms pending compute steps", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do o") return { exit: 1, output: "usage limit reached — resets at 3pm" };
      return { output: '{"n":1}', delayMs: 120 };
    });
    const io = makeIo(spawn);
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    // open-model quota storm (family=false): a pending compute step must not be
    // swept up just because its sentinel model is also non-Claude
    const p = plan(dir, [
      task("o", { provider: "ollama", model: "glm-4.6:cloud" }),
      task("slow", { provider: "claude", model: "claude-haiku-4-5-20251001" }),
      computeTask("c", "deps['slow'].n == 1", ["slow"]),
    ]);
    const r = await runPlan(p, cfgAllowed, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.o, "quota");
    equal(states.slow, "ok");
    equal(states.c, "ok");
    equal(readResult(p.resultsDir, "c").outputJson, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
