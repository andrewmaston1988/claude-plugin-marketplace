import { test } from "node:test";
import { equal, deepEqual, ok, rejects, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan, runTask, substituteTemplates, substituteItems, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir, resultPath, writeDigestMd, writeSummary, readHeartbeat, stopPath } from "../src/results.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
test("resume: a dependent whose upstream re-runs is invalidated, and the digest is not stale", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("find"),
      task("verify", { prompt: "check {{result:find}}", after: ["find"] }),
    ], { digest: { provider: "claude", model: "claude-haiku-4-5-20251001" } });
    initResultsDir(p.resultsDir);
    // prior pass: find FAILED, but verify and the digest succeeded against the
    // findings of a still-earlier pass.
    writeResult(p.resultsDir, "find", { id: "find", provider: "claude", model: "claude-haiku-4-5-20251001", ok: false, exit: 1, durationMs: 5, output: "boom" });
    writeResult(p.resultsDir, "verify", { id: "verify", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "STALE-verdict" });
    writeResult(p.resultsDir, DIGEST_ID, { id: DIGEST_ID, provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "STALE-digest" });
    writeDigestMd(p.resultsDir, "STALE-digest");

    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do find") return { output: "NEW-findings" };
      if (pr.startsWith("check ")) return { output: "FRESH-verdict" };
      return { output: "FRESH-digest" };
    });
    const io = makeIo(spawn);
    const r = await runPlan(p, CFG, io);

    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.find, "ok", "find had no valid cache — must re-run");
    equal(states.verify, "ok", "verify's upstream re-ran — its cached verdict is stale");
    equal(states[DIGEST_ID], "ok", "the digest depends on everything — anything re-running invalidates it");

    // the verifier must have been fed the NEW findings, not the old ones
    ok(spawn.calls.map(promptOf).includes("check NEW-findings"), spawn.calls.map(promptOf).join(" | "));

    // and the artifact on disk must be this pass's digest, not the previous one
    equal(readFileSync(join(p.resultsDir, "digest.md"), "utf8").trim(), "FRESH-digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Invalidation is transitive: A → B → C. If A re-runs, C is stale even though C
// never names A. One-hop invalidation would leave exactly the digest-shaped hole.
test("resume: invalidation is transitive across the dependency chain", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("a"),
      task("b", { prompt: "b uses {{result:a}}", after: ["a"] }),
      task("c", { prompt: "c uses {{result:b}}", after: ["b"] }),
    ]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "b", { id: "b", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "old-b" });
    writeResult(p.resultsDir, "c", { id: "c", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "old-c" });
    // a has no result at all → re-runs → b stale → c stale (c never mentions a)

    const spawn = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io = makeIo(spawn);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.a, "ok");
    equal(states.b, "ok", "b's upstream re-ran");
    equal(states.c, "ok", "c is two hops from a and must still be invalidated");
    equal(spawn.calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Resume must stay cheap: invalidation follows the graph, it does not nuke the run.
test("resume: an independent cached leaf is still skipped when an unrelated leaf re-runs", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("a"),
      task("b", { after: ["a"] }),
      task("d"), // independent of a and b
    ]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "d", { id: "d", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "cached-d" });

    const spawn = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io = makeIo(spawn);
    const r = await runPlan(p, CFG, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.d, "skipped", "d shares no dependency with the re-running leaves");
    equal(states.a, "ok");
    equal(states.b, "ok");
    equal(spawn.calls.length, 2, "only a and b dispatched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// runTask resolved while its leaf log was still flushing: `leafLog.end()` is
// fire-and-forget, so runPlan could resolve with writes still in flight. The run
// then "finishes" before results/<id>.log is durable — which surfaced in CI as
// ENOENT when a test's cleanup deleted the results dir out from under the flush,
// and in production as a leaf log that can be truncated at exit.
test("runTask does not resolve until its leaf log has finished flushing", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "results"), { recursive: true });
    const leafLog = createWriteStream(join(dir, "results", "a.log"));
    const spawn = fakeSpawnFactory(() => ({ output: "some leaf output" }));
    const io = makeIo(spawn);

    await runTask(task("a"), "do a", CFG, io, leafLog, {});

    equal(leafLog.writableFinished, true,
      "the stream must be fully flushed and closed before runTask resolves");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume skips ok results; --force reruns everything", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a"), task("b", { prompt: "use {{result:a}}", after: ["a"] })]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "a", {
      id: "a", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5, output: "prior-a",
      tokens: { input: 500, output: 40, cacheCreation: 0, cacheRead: 0 },
    });

    const spawn1 = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io1 = makeIo(spawn1);
    const r1 = await runPlan(p, CFG, io1);
    equal(spawn1.calls.length, 1); // only b ran
    equal(promptOf(spawn1.calls[0]), "use prior-a"); // skipped dep still feeds templates
    const states1 = Object.fromEntries(r1.summary.tasks.map((t) => [t.id, t.state]));
    equal(states1.a, "skipped");
    equal(states1.b, "ok");
    // a skipped leaf's prior tokens still count in the summary
    deepEqual(r1.summary.tasks.find((t) => t.id === "a").tokens, { input: 500, output: 40, cacheCreation: 0, cacheRead: 0 });

    const spawn2 = fakeSpawnFactory(() => ({ output: "fresh" }));
    const io2 = makeIo(spawn2);
    await runPlan(p, CFG, io2, { force: true });
    equal(spawn2.calls.length, 2); // both reran
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume does NOT skip failed or rate-limited results", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "a", { id: "a", provider: "claude", model: "claude-haiku-4-5-20251001", ok: false, exit: 1, output: "rate limit" });
    const spawn = fakeSpawnFactory(() => ({ output: "recovered" }));
    const r = await runPlan(p, CFG, makeIo(spawn));
    equal(spawn.calls.length, 1);
    equal(r.summary.tasks[0].state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest: synthesized last, engine writes digest.md from leaf output", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call).includes("digest stage") ? { output: "# The Digest\nheadlines" } : { output: "leaf" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")], { digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "" } });
    const r = await runPlan(p, CFG, io);
    equal(spawn.calls.length, 3);
    const digestCall = spawn.calls[2];
    ok(promptOf(digestCall).includes("digest stage")); // ran after all leaves
    equal(r.digestPath, join(p.resultsDir, "digest.md"));
    equal(readFileSync(r.digestPath, "utf8"), "# The Digest\nheadlines\n");
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states[DIGEST_ID], "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest failure: run completes, digestFailed flagged, no digest.md", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call).includes("digest stage") ? { exit: 1, output: "digest broke" } : { output: "leaf" });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a")], { digest: { provider: "claude", model: "claude-haiku-4-5-20251001" } });
    const r = await runPlan(p, CFG, io);
    equal(r.digestFailed, true);
    equal(r.digestPath, null);
    ok(!existsSync(join(p.resultsDir, "digest.md")));
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.a, "ok"); // leaf results unaffected
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health check: open-model plan fails fast when provider unreachable; claude-only never checks", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({}));
    let fetched = 0;
    const ioDown = makeIo(spawn, { fetch: async () => { fetched++; throw new Error("ECONNREFUSED"); } });
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    const openPlan = plan(dir, [task("o", { provider: "ollama", model: "glm-4.6:cloud" })]);
    await rejects(() => runPlan(openPlan, cfgAllowed, ioDown), /unreachable/);
    equal(fetched, 1);
    equal(spawn.calls.length, 0); // nothing dispatched

    const ioNever = makeIo(spawn, { fetch: async () => { throw new Error("should not be called"); } });
    const claudePlan = plan(dir, [task("c")], { resultsDir: join(dir, "run2") });
    await runPlan(claudePlan, CFG, ioNever); // does not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open-model dispatch passes env trio through real spawn (shim log)", async () => {
  const dir = tmp();
  try {
    const shimLog = join(dir, "shim.log");
    const io = makeIo(
      (cmd, args, opts) => nodeSpawn(process.execPath, [SHIM, ...args], opts),
      { env: { ...process.env, SWARM_SHIM_LOG: shimLog, SWARM_SHIM_OUTPUT: "open-leaf-done" } },
    );
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()], url: "http://127.0.0.1:65500" } };
    const workCwd = mkdtempSync(join(tmpdir(), "swarm-cwd-"));
    const p = plan(dir, [task("o", { provider: "ollama", model: "minimax-m3:cloud", cwd: workCwd })]);
    const r = await runPlan(p, cfgAllowed, io);
    const entry = JSON.parse(readFileSync(shimLog, "utf8").trim());
    equal(entry.env.ANTHROPIC_MODEL, "minimax-m3:cloud");
    equal(entry.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:65500");
    equal(entry.env.ANTHROPIC_API_KEY, "ollama");
    ok(entry.argv[0] === "-p" && entry.argv[1].startsWith("do o")); // engine notice rides after
    ok(entry.cwd.toLowerCase().startsWith(workCwd.toLowerCase().slice(0, 8)));
    equal(readResult(p.resultsDir, "o").output, "open-leaf-done");
    equal(r.summary.tasks[0].state, "ok");
    rmSync(workCwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a private-mode leaf spawns at the same depth inside its worktree; an explicit worktree leaf at the root", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "y.txt"), "y\n");
    commitAllInRepo(repo, "sub");
    const cwds = [];
    const spawn2 = fakeSpawnFactory((call) => { cwds.push(call.opts.cwd); return {}; });
    const sub = join(repo, "sub");
    const p = plan(repo, [
      task("gen", { cwd: sub, originalCwd: sub, allowedTools: "Bash",         worktreeName: "gen", branchScope: "scope1", checkoutToplevel: repo }),
    ], { resultsDir: join(dir, "run"), concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn2));
    equal(cwds.length, 1);
    equal(cwds[0], join(dir, "run", "wt-gen", "sub"));

    const cwds2 = [];
    const spawn3 = fakeSpawnFactory((call) => { cwds2.push(call.opts.cwd); return {}; });
    const p2 = plan(repo, [
      task("expl", { cwd: sub, originalCwd: sub, allowedTools: "Bash", worktreeName: "expl" }),
    ], { resultsDir: join(dir, "run2"), concurrency: 1 });
    await runPlan(p2, CFG, makeIo(spawn3));
    equal(cwds2[0], join(dir, "run2", "wt-expl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stdout contract: roster snapshots per state change, never raw output", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "SECRET-RAW-OUTPUT" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a"), task("b")]);
    await runPlan(p, CFG, io);
    equal(io.lines.length, 0); // the engine paints snapshots; the CLI owns the closing block
    ok(io.snapshots.length >= 3, `one paint per state change, got ${io.snapshots.length}`);
    const last = io.snapshots.at(-1);
    ok(/✓ {2}a\s+claude-haiku-4-5-20251001/.test(last), last);
    ok(/✓ {2}b\s+claude-haiku-4-5-20251001/.test(last), last);
    ok(last.includes("2 ok"), last);
    ok(last.startsWith("swarm · run · 2 tasks"), last);
    ok(!io.snapshots.some((s) => s.includes("SECRET-RAW-OUTPUT")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream-json leaf: result text extracted, tokens accounted end-to-end", async () => {
  const dir = tmp();
  try {
    const streamOut = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-abc" }),
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1000, output_tokens: 50 } } }),
      JSON.stringify({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 500 } } }),
      JSON.stringify({
        type: "result", subtype: "success", is_error: false, result: "the extracted answer",
        usage: { input_tokens: 3000, output_tokens: 200, cache_read_input_tokens: 500 },
        total_cost_usd: 0.05, num_turns: 2,
      }),
    ].join("\n") + "\n";
    const spawn = fakeSpawnFactory(() => ({ output: streamOut }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    const r = await runPlan(p, CFG, io);

    const res = readResult(p.resultsDir, "leaf");
    equal(res.output, "the extracted answer");
    deepEqual(res.tokens, { input: 3000, output: 200, cacheCreation: 0, cacheRead: 500 });
    equal(res.costUsd, 0.05);
    equal(res.numTurns, 2);
    // interrogation fields: session to resume, where, and with which tools
    equal(res.sessionId, "s-abc");
    equal(res.cwd, tmpdir());
    equal(res.originalCwd, tmpdir()); // pre-redirect cwd — the governance identity
    equal(res.allowedTools, "Read,Grep,Glob");

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.event === "tokens" && l.id === "leaf"), "expected a live tokens event in run.log");
    const done = logLines.find((l) => l.id === "leaf" && l.state === "ok");
    equal(done.tokens.input, 3000);
    ok(done.durationMs != null, "terminal run.log line carries durationMs");

    deepEqual(r.summary.tasks[0].tokens, { input: 3000, output: 200, cacheCreation: 0, cacheRead: 500 });
    deepEqual(r.summary.totalTokens, { input: 3000, output: 200, cacheCreation: 0, cacheRead: 500 });

    // final roster row shows the leaf's work 3000+200 = 3.2k; the 500 cache read counts in the run total only
    ok(io.snapshots.some((s) => /leaf.*3\.2k/.test(s)), io.snapshots.at(-1));
    ok(!io.snapshots.some((s) => s.includes("extracted answer")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream-json leaf: is_error result fails the task even on exit 0", async () => {
  const dir = tmp();
  try {
    const streamOut = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "it broke" }) + "\n";
    const spawn = fakeSpawnFactory(() => ({ output: streamOut, exit: 0 }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed");
    equal(readResult(p.resultsDir, "leaf").ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: tool_use events reach run.log and the mid-run roster", async () => {
  const dir = tmp();
  try {
    const streamOut = [
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Grep", input: { path: "src/auth" } }], usage: { input_tokens: 100, output_tokens: 10 } } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "found it" }),
    ].join("\n") + "\n";
    // output at 50ms, close at 350ms — heartbeats in between paint the activity
    const spawn = fakeSpawnFactory(() => ({ output: streamOut, outputAtMs: 50, delayMs: 350 }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    await runPlan(p, { ...CFG, heartbeatSecs: 0.05 }, io);

    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const act = logLines.find((l) => l.event === "activity" && l.id === "leaf");
    equal(act.activity, "Grep src/auth");
    ok(io.snapshots.some((s) => /◐ {2}leaf.*Grep src\/auth/.test(s)), "mid-run snapshot should show activity");
    ok(!/Grep src\/auth/.test(io.snapshots.at(-1)), "terminal snapshot must not carry activity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: a leaf with no stream events goes ⚠ quiet after quietWarnSecs", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "plain text at the end", delayMs: 350 }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("mute")]);
    await runPlan(p, { ...CFG, heartbeatSecs: 0.05, quietWarnSecs: 0.1 }, io);
    ok(io.snapshots.some((s) => /◐ {2}mute.*⚠ quiet \d+s/.test(s)), `expected a quiet warning:\n${io.snapshots.at(-2)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat repaints the roster with climbing elapsed while a leaf runs", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 300, output: "x" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("slow")]);
    await runPlan(p, { ...CFG, heartbeatSecs: 0.05 }, io);
    const runningPaints = io.snapshots.filter((s) => s.includes("◐")).length;
    ok(runningPaints >= 2, `expected ≥2 running snapshots, got ${runningPaints}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyFailure: a stopped leaf reads failed:stopped even when it also timed out", () => {
  equal(classifyFailure({ timedOut: true, output: "", stopped: true }), "failed:stopped");
  equal(classifyFailure({ timedOut: false, output: "", stopped: false }), "failed");
});

test("liveness: heartbeat file is touched on every tick, including while a leaf sits in backoff", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const spawn = fakeSpawnFactory(() => (++calls === 1 ? { exit: 1, output: "429 rate limit" } : { output: "recovered" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("leaf")]);
    const seen = new Set();
    const poll = setInterval(() => {
      const hb = readHeartbeat(p.resultsDir);
      if (hb) seen.add(hb.mtimeMs);
    }, 15);
    try {
      await runPlan(p, { ...CFG, heartbeatSecs: 0.05, retry: { backoffMs: 150, rateLimited: 2 } }, io);
    } finally {
      clearInterval(poll);
    }
    ok(seen.size >= 2, `expected the heartbeat file touched more than once (incl. during backoff), saw ${seen.size} distinct mtimes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
