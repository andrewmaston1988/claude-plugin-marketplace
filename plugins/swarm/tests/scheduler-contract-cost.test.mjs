import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan, substituteItems } from "../src/scheduler.mjs";
import { readResult, resultPath } from "../src/results.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
test("substituteItems unit: whole item, nested paths, index, missing fields", () => {
  equal(substituteItems("fix {{item.f}} #{{index}}", { f: "a" }, 0), "fix a #0");
  equal(substituteItems("{{item}}", { a: 1 }, 2), '{"a":1}');
  equal(substituteItems("{{item}}", "plain", 0), "plain");
  equal(substituteItems("{{item.a.b}}", { a: { b: "x" } }, 0), "x");
  equal(substituteItems("{{item.missing}}", {}, 0), "");
  equal(substituteItems("{{item.n}}", { n: 5 }, 0), "5");
});

test("JSON leaf output is parsed into outputJson alongside raw", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"verdict":"pass","score":9}' }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("judge")]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "judge");
    equal(res.output, '{"verdict":"pass","score":9}');
    deepEqual(res.outputJson, { verdict: "pass", score: 9 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── returns (schema-validated output) ─────────────────────────────────────────

const SITES_SCHEMA = { type: "object", required: ["sites"], properties: { sites: { type: "array" } } };

test("returns: conforming first output passes untouched — no second spawn", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut(JSON.stringify({ sites: [1] }), "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    deepEqual(res.outputJson, { sites: [1] });
    equal(res.schemaRetried, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: invalid output gets one teaching re-ask via session resume, then ok", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => i === 0
      ? { output: streamOut(JSON.stringify(["a.mjs"]), "s-1") } // valid JSON, wrong shape
      : { output: streamOut(JSON.stringify({ sites: ["a.mjs"] }), "s-2", { input_tokens: 50, output_tokens: 5 }) });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 2);
    const retry = spawn.calls[1];
    const ri = retry.args.indexOf("--resume");
    equal(retry.args[ri + 1], "s-1");
    const rp = promptOf(retry);
    ok(rp.includes("expected object"), rp);        // the validator's teaching error
    ok(rp.includes(JSON.stringify(SITES_SCHEMA, null, 2)), rp); // the schema itself — the original prompt may have underspecified the shape
    ok(/only.*json/i.test(rp), rp);                // corrective instruction

    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    deepEqual(res.outputJson, { sites: ["a.mjs"] });
    equal(res.schemaRetried, true);
    equal(res.sessionId, "s-2");                   // next ask continues the corrected thread
    deepEqual(res.tokens, { input: 150, output: 15, cacheCreation: 0, cacheRead: 0 });

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.event === "leaf-contract-retry" && l.id === "a"), "expected leaf-contract-retry in run.log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: still-invalid after three re-asks fails with the validator's message", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("still prose", "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 4, "one dispatch plus three re-asks");
    const attempts = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "leaf-contract-retry" && e.id === "a")
      .map((e) => e.attempt);
    deepEqual(attempts, [1, 2, 3], `every re-ask must log its attempt, got ${JSON.stringify(attempts)}`);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    ok(Array.isArray(res.schemaErrors) && res.schemaErrors.length > 0, JSON.stringify(res));
    ok(res.output.includes("returns validation failed"), res.output);
    // The leaf's own output survives the validator's text, so a re-run can re-ask
    // off it — read back from the file, not from the in-memory result.
    equal(JSON.parse(readFileSync(resultPath(p.resultsDir, "a"), "utf8")).rawOutput, "still prose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: a schema miss gets up to three re-asks — the third can still land ok", async () => {
  const dir = tmp();
  try {
    // Prose, then the wrong shape twice, right on the last: the third re-ask is
    // the one that saves the leaf.
    const spawn = fakeSpawnFactory((call, i) => (i < 3
      ? { output: streamOut(i === 0 ? "still prose" : JSON.stringify(["a.mjs"]), `s-${i}`) }
      : { output: streamOut(JSON.stringify({ sites: ["a.mjs"] }), `s-${i}`) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 4, "one dispatch plus three re-asks");
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    deepEqual(res.outputJson, { sites: ["a.mjs"] });
    equal(res.schemaRetried, true);
    equal(res.sessionId, "s-3", "next ask continues the corrected thread");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── re-run: a contract-failed leaf resumes on its correction ──────────────────
// A leaf that finished its work and only fumbled its JSON must not redo that work
// when the manifest is re-run: it is resumed on the correction, not the prompt.

test("resume: a contract-failed leaf is re-asked on its correction, not re-run on its prompt", async () => {
  const dir = tmp();
  try {
    let pass = 1;
    const spawn = fakeSpawnFactory(() => (pass === 1
      ? { output: streamOut("still prose", "s-leaf") }
      : { output: streamOut(JSON.stringify({ sites: ["a.mjs"] }), "s-leaf-2") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA }), task("b")]);

    await runPlan(p, CFG, io);
    const firstRun = spawn.calls.length;
    equal(readResult(p.resultsDir, "a").ok, false, "the first run must fail the leaf");
    equal(readResult(p.resultsDir, "b").ok, true);

    pass = 2;
    const r = await runPlan(p, CFG, io);
    const second = spawn.calls.slice(firstRun);
    const stateOf = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(stateOf.b, "skipped", "an ok sibling is never re-dispatched");
    equal(second.length, 1, "the failed leaf goes straight to its correction — no full re-run");
    const argv = second[0].args;
    equal(argv[argv.indexOf("--resume") + 1], "s-leaf", "the re-ask continues the leaf's own session");
    const sent = sentPrompt(second[0]);
    ok(sent.includes("did not match the task's returns schema"), sent);
    ok(!sent.includes("do a"), `the original prompt must not be re-sent: ${sent}`);

    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.schemaRetried, true);
    equal(res.sessionId, "s-leaf-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: the corrected result counts the re-asks' spend only, never the first run's", async () => {
  const dir = tmp();
  try {
    let pass = 1;
    const spawn = fakeSpawnFactory((call) => {
      // A slow, expensive first run — the spend a resume must never re-add.
      if (pass === 1) {
        return { output: streamOut("still prose", "s-leaf", { input_tokens: 1000, output_tokens: 100 }, 0.5), delayMs: 60 };
      }
      // Anything but the correction comes back as prose again: only a leaf resumed
      // on its own correction can land ok here.
      return sentPrompt(call).includes("did not match the task's returns schema")
        ? { output: streamOut(JSON.stringify({ sites: ["a.mjs"] }), "s-leaf-2", { input_tokens: 7, output_tokens: 3 }, 0.01) }
        : { output: streamOut("still prose", "s-leaf-2", { input_tokens: 1000, output_tokens: 100 }), delayMs: 60 };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    const prior = JSON.parse(readFileSync(resultPath(p.resultsDir, "a"), "utf8"));
    ok(prior.durationMs >= 40, `the first run must be the expensive one: ${prior.durationMs}ms`);

    pass = 2;
    await runPlan(p, CFG, io);
    const res = JSON.parse(readFileSync(resultPath(p.resultsDir, "a"), "utf8"));
    equal(res.ok, true);
    deepEqual(res.tokens, { input: 7, output: 3, cacheCreation: 0, cacheRead: 0 });
    equal(res.costUsd, 0.01, "the first run's cost must not ride into the corrected row");
    equal(res.schemaErrors, undefined, "a recovered leaf must not keep the failure's errors");
    // One re-ask's worth of wall-clock, not a fresh dispatch's: the synthetic
    // first result carries zero duration, so only the correction is timed.
    ok(res.durationMs < 30,
      `the resumed result times the re-asks alone: ${res.durationMs}ms vs ${prior.durationMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a contract-failed leaf whose task definition changed re-runs on its full prompt", async () => {
  const dir = tmp();
  try {
    const cwd = tmpdir();
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("still prose", "s-leaf") }));
    const io = makeIo(spawn);
    const mk = (prompt) => plan(dir, [task("a", { prompt, cwd, originalCwd: cwd, returns: SITES_SCHEMA })]);
    const p = mk("do a");
    await runPlan(p, CFG, io);
    equal(readResult(p.resultsDir, "a").ok, false);

    const before = spawn.calls.length;
    await runPlan(mk("do a differently"), CFG, io);
    const second = spawn.calls.slice(before);
    equal(promptOf(second[0]), "do a differently",
      "an edited definition is new spend: the leaf re-runs its own prompt");
    ok(!sentPrompt(second[0]).includes("did not match the task's returns schema"),
      "a changed definition must not be corrected against the old output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a failed row with no rawOutput, or no key, falls back to the full prompt", async () => {
  const spawn = fakeSpawnFactory(() => ({ output: streamOut("still prose", "s-leaf") }));
  const io = makeIo(spawn);
  const dirs = [];
  try {
    // Each variant strips a REAL failed result: everything else — key included,
    // or everything but it — is the engine's own, so the only difference from the
    // correcting case is the missing field.
    for (const strip of ["rawOutput", "key"]) {
      const dir = tmp();
      dirs.push(dir);
      const cwd = tmpdir();
      const mk = () => plan(dir, [task("a", { cwd, originalCwd: cwd, returns: SITES_SCHEMA })]);
      await runPlan(mk(), CFG, io);
      const path = resultPath(join(dir, "run"), "a");
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      equal(onDisk.ok, false, "the seeded run must fail the leaf");
      equal(onDisk.rawOutput, "still prose", "a schema failure keeps the leaf's own output");
      ok(onDisk.key, "the engine writes a key");
      delete onDisk[strip];
      writeFileSync(path, JSON.stringify(onDisk, null, 2) + "\n");

      const before = spawn.calls.length;
      await runPlan(mk(), CFG, io);
      const second = spawn.calls.slice(before);
      equal(promptOf(second[0]), "do a", `${strip}: the full prompt, not a correction`);
    }
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: no session id means no re-ask — fail immediately, one spawn", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "plain text, no stream-json" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    ok(res.output.includes("no session id"), res.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns on a forEach task: clones validate individually; the aggregate is engine-built and exempt", async () => {
  const dir = tmp();
  try {
    const CLONE_SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const spawn = fakeSpawnFactory((call) => {
      const prompt = promptOf(call);
      if (prompt.startsWith("do list")) return { output: streamOut(JSON.stringify({ sites: ["a", "b"] }), "s-list") };
      if (call.args.includes("--resume")) return { output: streamOut(JSON.stringify({ ok: false }), "s-fix") };
      if (prompt === "check a") return { output: streamOut("prose from clone 0", "s-c0") };
      return { output: streamOut(JSON.stringify({ ok: true }), "s-c1") };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("list"),
      task("per", {
        prompt: "check {{item}}",
        after: ["list"],
        forEach: { from: "list", path: "sites", maxItems: 5 },
        returns: CLONE_SCHEMA,
      }),
    ]);
    await runPlan(p, CFG, io);

    equal(readResult(p.resultsDir, "per[0]").schemaRetried, true);  // corrected via resume
    equal(readResult(p.resultsDir, "per[0]").ok, true);
    equal(readResult(p.resultsDir, "per[1]").schemaRetried, undefined);
    const agg = readResult(p.resultsDir, "per");
    equal(agg.ok, true);                                            // array aggregate never re-validated
    deepEqual(agg.outputJson, [{ ok: false }, { ok: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cost consent (estimates + single-shot projection warn) ────────────────────

test("summary task rows carry model, and costUsd only for real-key leaves; summary.estimate persists", async () => {
  const dir = tmp();
  try {
    // 'a' billed via API key -> costUsd is real; 'b' subscription -> synthetic, kept out of the corpus
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "do a"
      ? { output: streamOut("done", "s-1", { input_tokens: 100, output_tokens: 10 }, 0.25, "ANTHROPIC_API_KEY") }
      : { output: streamOut("done", "s-2", { input_tokens: 100, output_tokens: 10 }, 0.25, "none") });
    const io = makeIo(spawn);
    const est = { tokens: 1234, counted: [{ provider: "claude", model: "claude-haiku-4-5-20251001", leaves: 1, perLeaf: 1234 }], unknown: [] };
    const p = plan(dir, [task("a"), task("b")], { estimate: est });
    const r = await runPlan(p, CFG, io);
    const rowA = r.summary.tasks.find((t) => t.id === "a");
    equal(rowA.model, "claude-haiku-4-5-20251001");
    equal(rowA.costUsd, 0.25);
    const rowB = r.summary.tasks.find((t) => t.id === "b");
    equal(rowB.costUsd, undefined);
    deepEqual(r.summary.estimate, est);
    ok(io.lines.some((l) => l.includes("estimated ~1.2k tokens")), io.lines.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: fires exactly once when the projection crosses costWarnTokens — stdout, run.log, notify", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({
      output: streamOut(`leaf ${i}`, `s-${i}`, { input_tokens: 3000, output_tokens: 0 }),
      delayMs: [5, 20, 300][i] ?? 1,
    }));
    const notified = [];
    const io = makeIo(spawn, { notify: (msg) => notified.push(msg) });
    const p = plan(dir, [task("a"), task("b"), task("c")]);
    const r = await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);

    const warns = io.lines.filter((l) => l.includes("projected"));
    equal(warns.length, 1);
    ok(warns[0].includes("⚠"), warns[0]);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = logLines.filter((l) => l.event === "cost-warn");
    equal(events.length, 1);
    equal(events[0].unit, "tokens");
    equal(events[0].threshold, 5000);
    equal(events[0].projected, 9000); // 6000 spent after 2 leaves + 3000 avg × 1 remaining
    equal(notified.length, 1);
    equal(r.summary.costWarnFired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: silent under threshold, and disabled entirely by costWarn:false", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("x", "s", { input_tokens: 10, output_tokens: 0 }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")]);
    const r = await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);
    equal(io.lines.filter((l) => l.includes("projected")).length, 0);
    equal(r.summary.costWarnFired, undefined);

    const spawn2 = fakeSpawnFactory(() => ({ output: streamOut("x", "s", { input_tokens: 3000, output_tokens: 0 }) }));
    const io2 = makeIo(spawn2);
    const p2 = plan(tmp(), [task("a"), task("b")]);
    await runPlan(p2, { ...CFG, costWarn: false, costWarnTokens: 5000 }, io2);
    equal(io2.lines.filter((l) => l.includes("projected")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: projects in dollars only when every completed leaf's costUsd is real-key billed", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({
      output: streamOut(`leaf ${i}`, `s-${i}`, { input_tokens: 10, output_tokens: 0 }, 6, "ANTHROPIC_API_KEY"),
      delayMs: [5, 20][i] ?? 1,
    }));
    const io = makeIo(spawn, { notify: () => {} });
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, { ...CFG, costWarnUsd: 10 }, io);
    const warns = io.lines.filter((l) => l.includes("projected"));
    equal(warns.length, 1);
    ok(warns[0].includes("$"), warns[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost warn: subscription costUsd is synthetic — projection stays token-denominated", async () => {
  const dir = tmp();
  try {
    // subscription leaves report costUsd but apiKeySource "none": the $10
    // default must NOT swallow the warn; tokens cross their threshold instead
    const spawn = fakeSpawnFactory((call, i) => ({
      output: streamOut(`leaf ${i}`, `s-${i}`, { input_tokens: 3000, output_tokens: 0 }, 0.05, "none"),
      delayMs: [5, 20][i] ?? 1,
    }));
    const io = makeIo(spawn, { notify: () => {} });
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);
    const warns = io.lines.filter((l) => l.includes("projected"));
    equal(warns.length, 1);
    ok(warns[0].includes("tokens"), warns[0]);
    ok(!warns[0].includes("$"), warns[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── child manifests (bounded composition) ─────────────────────────────────────
