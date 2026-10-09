// The coverage half of the leaf contract: a shortfall is chased while the leaf is
// making progress, a leaf that read NOTHING fails instead of passing, and a codex
// leaf is handed its read plan as files it can actually see. Sibling of
// coverage.test.mjs, which is over the 500-line bar and may not grow.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/scheduler.mjs";
import { formatClosing } from "../src/results-render.mjs";
import { readResult, writeResult, initResultsDir } from "../src/results.mjs";
import { taskKey } from "../src/task-key.mjs";
import { fakeSpawnFactory, makeIo, sentPrompt, usageEnv, codexReading } from "./helpers/fake-io.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "swarm-contract-cov-")); }
const writeLines = (dir, name, n) => { const p = join(dir, name); writeFileSync(p, "x\n".repeat(n)); return p; };

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4, timeoutMs: 600000, resultInlineCap: 4000, worktreeBranchPrefix: "swarm/",
};
const CODEX_CFG = (cwd) => ({
  providers: { codex: { enabled: true, path: "codex", allowedRoots: [cwd] } },
  concurrency: 4, timeoutMs: 600000, resultInlineCap: 4000, worktreeBranchPrefix: "swarm/",
});

const task = (id, cwd, over = {}) => ({
  id, prompt: `do ${id}`, provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Grep,Glob",
  cwd, originalCwd: cwd, timeoutMs: 5000, after: [], ...over,
});
const plan = (dir, tasks) => ({ cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "" });

// ── claude leaf transcripts ───────────────────────────────────────────────────
let _uid = 0;
const readTurns = (reads) => {
  const withIds = reads.map((r) => ({ ...r, id: `tu${_uid++}` }));
  return [JSON.stringify({
    type: "assistant",
    message: { id: `m${_uid}`, stop_reason: "end_turn", content: withIds.map((r) => ({
      type: "tool_use", id: r.id, name: "Read", input: { file_path: r.file, offset: r.offset, limit: r.limit },
    })) },
  }), JSON.stringify({
    type: "user",
    message: { content: withIds.map((r) => ({ type: "tool_result", tool_use_id: r.id, is_error: false, content: "" })) },
  })].join("\n");
};
// A leaf that read nothing still SPOKE — an empty transcript is "unparseable",
// a different state entirely, and one a shell-less leaf never produces.
const spoke = (text) => JSON.stringify({
  type: "assistant", message: { id: `m${_uid++}`, stop_reason: "end_turn", content: [{ type: "text", text }] },
});
// One claude leaf's stdout. `withInit:false` omits the init event — no session id.
const leafOut = (reads, { sid = "s-1", result = "done", withInit = true } = {}) => [
  ...(withInit ? [JSON.stringify({ type: "system", subtype: "init", session_id: sid })] : []),
  reads.length ? readTurns(reads) : spoke(result),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result }),
].join("\n") + "\n";

const ANSWER_SCHEMA = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
// Which retry prompt a call carries, by the blocks the engine writes.
const TEACHING = "You did not read everything this task requires";
const SCHEMA_BLOCK = "Your output did not match the task's returns schema";

// A 12,000-line file: six 2,000-line retry pages. The transcript APPENDS across a
// re-ask, so a leaf that reads one more page per turn closes one more page of the gap.
const PAGE = 2000;
const readPage = (F, i) => ({ file: F, offset: i * PAGE + 1, limit: PAGE });

// ── the loop ──────────────────────────────────────────────────────────────────

test("coverage: the re-ask continues while each turn closes lines, and the leaf completes", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 12000);
    // The old loop stopped after ONE coverage re-ask; this leaf needs two more, each
    // one closing 4,000 lines, so only a progress gate lets it finish inside the cap.
    const spawn = fakeSpawnFactory((call, i) => ({
      output: leafOut([{ file: F, offset: 1, limit: Math.min(12000, 2 * PAGE * (i + 1)) }], { sid: `s-${i + 1}` }),
    }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    ok(spawn.calls.length > 2, `expected more than one re-ask, got ${spawn.calls.length}`);
    equal(readResult(p.resultsDir, "a").coverage.status, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage: every coverage re-ask carries the teaching block, not just the first", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 12000);
    const spawn = fakeSpawnFactory((call, i) => ({
      output: leafOut([{ file: F, offset: 1, limit: Math.min(12000, 2 * PAGE * (i + 1)) }], { sid: `s-${i + 1}` }),
    }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 3, "two re-asks, then complete");
    for (const i of [1, 2]) ok(sentPrompt(spawn.calls[i]).includes(TEACHING), `re-ask ${i}:\n${sentPrompt(spawn.calls[i])}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage: the first coverage re-ask is always granted — a leaf that closes nothing gets exactly one", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: `s-${i + 1}` }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 2); // initial + exactly one, though nothing moved
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage: the re-ask cap holds at four — a leaf still closing lines is stopped there anyway", async () => {
  const dir = tmp();
  try {
    // Six retry pages, one closed per turn: five dispatches at most, and the last
    // one still made progress (its gap is a single page), so only the cap stopped it.
    const F = writeLines(dir, "big.mjs", 12000);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([readPage(F, i)], { sid: `s-${i + 1}` }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    equal(spawn.calls.length, 1 + 4, "the coverage budget is its own four re-asks");
    const res = readResult(p.resultsDir, "a");
    equal(res.coverage.status, "incomplete");
    deepEqual(res.coverage.missed, [`${F}:10001-12000`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage: the schema and coverage budgets are independent — coverage turns never spend a schema re-ask", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 12000);
    // call 1: schema miss AND a coverage shortfall. calls 2-3: schema clean, gap
    // closing. call 4: schema miss again — the schema budget is untouched by then.
    const body = (i) => (i === 1 || i === 4 ? "{}" : JSON.stringify({ answer: "x" }));
    const spawn = fakeSpawnFactory((call, i) => ({
      output: leafOut([readPage(F, i)], { sid: `s-${i + 1}`, result: body(i) }),
    }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F], returns: ANSWER_SCHEMA })]);
    await runPlan(p, CFG, io); // must resolve — a coverage-only turn may not reach failSchema(cur, null)
    ok(spawn.calls.length >= 6, `call 4's schema miss must still re-ask; got ${spawn.calls.length} calls`);
    ok(sentPrompt(spawn.calls[5]).includes(SCHEMA_BLOCK), sentPrompt(spawn.calls[5]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── zero engagement ───────────────────────────────────────────────────────────

// The one failure shape: the leaf engaged with nothing it was told to read.
for (const [name, spawnOf, sid] of [
  ["loop end", (F) => fakeSpawnFactory((call, i) => ({ output: leafOut([], { sid: `s-${i + 1}`, result: "no idea" }) })), true],
  ["no session id", (F) => fakeSpawnFactory(() => ({ output: leafOut([], { result: "no idea", withInit: false }) })), false],
  ["a failed re-ask", (F) => fakeSpawnFactory((call, i) => (i === 0
    ? { output: leafOut([], { sid: "s-1", result: "no idea" }) }
    : { exit: 1, output: "" })), true],
]) {
  test(`coverage: a leaf that read nothing fails on ${name} — ok:false, coverageFailed, rawOutput kept`, async () => {
    const dir = tmp();
    try {
      const F = writeLines(dir, "big.mjs", 2500);
      const spawn = spawnOf(F);
      const io = makeIo(spawn);
      const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
      await runPlan(p, CFG, io);
      const res = readResult(p.resultsDir, "a");
      equal(res.ok, false, JSON.stringify(res.coverage));
      equal(res.coverageFailed, true);
      equal(res.rawOutput, "no idea"); // the leaf's own answer, kept for a corrective resume
      ok(!spawn.calls.length || existsSync(join(p.resultsDir, "results", "a.log")) || sid === false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// The result FILE carrying coverageFailed is not enough: the closing block reads
// the run-level gap list, so a gap entry that drops the flag renders the leaf as a
// mere shortfall ("read 0 of 1") — the loudest line in the block, silently lost.
test("coverage: a zero-engagement leaf reaches the closing block as the red line", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([], { sid: `s-${i + 1}`, result: "no idea" }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    const r = await runPlan(p, CFG, io);
    const gaps = r.summary.coverageGaps;
    ok(gaps?.length, `no run-level gap entry at all: ${JSON.stringify(gaps)}`);
    const closing = formatClosing({ summaryPath: "S/summary.json", digestPath: "d", coverageGaps: gaps });
    ok(closing.includes("engaged with none of its 1 required inputs"), closing);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage: a leaf that never read anything settles as failed, not as a rate-limit retry", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    // A stray 429 in the stream: classifyFailure would retry this, and then switch
    // it to the fallback model. A semantic coverage failure is not transient.
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([], { sid: `s-${i + 1}`, result: "429 Too Many Requests" }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F], fallbackModel: "claude-haiku-4-5-20251001" })]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed");
    equal(spawn.calls.length, 2, "initial + the one coverage re-ask, and no retry or fallback");
    equal(readResult(p.resultsDir, "a").ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage: a coverageFailed leaf resumes on its correction, not on the original prompt", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const t = task("a", dir, { mustRead: [F] });
    const p = plan(dir, [t]);
    initResultsDir(p.resultsDir);
    writeResult(p.resultsDir, "a", {
      id: "a", key: taskKey(t), provider: "claude", runner: "claude", model: t.model,
      ok: false, exit: 0, durationMs: 1200, numTurns: 3, sessionId: "s-prior",
      output: "the coverage failure text", rawOutput: "my first answer",
      coverageFailed: true,
    });
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: "s-2" }) }));
    const io = makeIo(spawn);
    await runPlan(p, CFG, io);
    const first = sentPrompt(spawn.calls[0]);
    ok(first.includes(TEACHING), first);
    ok(!first.includes("do a"), "the original prompt was re-sent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the stamp ─────────────────────────────────────────────────────────────────

test("coverage: the result stamp carries missedItems and uncoverable, not only the counts", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }]) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    const cov = readResult(p.resultsDir, "a").coverage;
    deepEqual(
      { required: cov.required, read: cov.read, missedItems: cov.missedItems, uncoverable: cov.uncoverable },
      { required: 1, read: 1, missedItems: 0, uncoverable: [] },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the codex read plan ───────────────────────────────────────────────────────

// The parts a launch wrote for one leaf, in order.
function readParts(resultsDir, id) {
  const dir = join(resultsDir, "results");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${id}.reads-`) && f.endsWith(".txt"))
    .sort((a, b) => Number(a.match(/reads-(\d+)/)[1]) - Number(b.match(/reads-(\d+)/)[1]))
    .map((f) => ({ path: join(dir, f), text: readFileSync(join(dir, f), "utf8") }));
}

// A real repo: only a write-capable leaf gets a worktree, and only a repo can host one.
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-contract-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "rel.md"), "a\nb\nc\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  return repo;
}

const CODEX_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "t-reads" }),
  JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "codex answer" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
].join("\n") + "\n";

test("launch: a codex leaf's read plan is written as part files naming the worktree's own paths, and the notice names them", async () => {
  const repo = initRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: CODEX_STREAM }));
    const io = makeIo(spawn, { env: usageEnv({ codex: codexReading() }) });
    const p = plan(dir, [{
      id: "cx", prompt: "review it", provider: "codex", model: "gpt-5-codex",
      allowedTools: "Read,Bash", cwd: repo, originalCwd: repo, timeoutMs: 5000, after: [],
      mustRead: ["rel.md"], // relative: it resolves against the leaf's OWN cwd
    }]);
    await runPlan(p, CODEX_CFG(repo), io);
    const parts = readParts(p.resultsDir, "cx");
    ok(parts.length >= 1, `no read-plan part files written: ${readdirSync(join(p.resultsDir, "results")).join(", ")}`);
    // The worktree is where the leaf runs, so that is the path every command must name.
    const wt = readResult(p.resultsDir, "cx").cwd;
    ok(wt !== repo, "the leaf must have been given a worktree to make the cwd meaningful");
    ok(parts[0].text.includes(join(wt, "rel.md")), parts[0].text);
    ok(parts[0].text.includes("lines 1-3"), parts[0].text);
    // …and the leaf is told where they are, so it runs them before it answers.
    const sent = sentPrompt(spawn.calls[0]);
    for (const part of parts) ok(sent.includes(part.path), `notice does not name ${part.path}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launch: a claude leaf is given no read-plan files — its reads are Read calls", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }]) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    deepEqual(readParts(p.resultsDir, "a"), []);
    ok(!sentPrompt(spawn.calls[0]).includes("Your required reads are listed in the files below"), sentPrompt(spawn.calls[0]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launch: a codex leaf's stamp carries the uncoverable lines nothing can show it", async () => {
  const dir = tmp();
  try {
    const big = join(dir, "huge.mjs");
    writeFileSync(big, "y".repeat(50_000) + "\n");
    const spawn = fakeSpawnFactory(() => ({ output: CODEX_STREAM }));
    const io = makeIo(spawn, { env: usageEnv({ codex: codexReading() }) });
    const p = plan(dir, [{
      id: "cx", prompt: "review it", provider: "codex", model: "gpt-5-codex", allowedTools: "Read",
      cwd: dir, originalCwd: dir, timeoutMs: 5000, after: [], mustRead: [{ path: big, lines: [[1, 1]] }],
    }]);
    await runPlan(p, CODEX_CFG(dir), io);
    const cov = readResult(p.resultsDir, "cx").coverage;
    deepEqual(cov.uncoverable, [{ path: big, ranges: [[1, 1]] }]);
    equal(cov.required, 0); // a requirement nothing can satisfy is not a requirement
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// An unresolvable mustRead is the ENGINE's gap, not the leaf's: the leaf cannot
// read a path that does not exist, so it must not be failed for reading none of
// it. The shortfall is still recorded (D9) — warned, kept, leaf ok.
test("coverage: a mustRead that does not resolve is a recorded shortfall, not a zero-engagement failure", async () => {
  const dir = tmp();
  try {
    const missing = join(dir, "never-written.mjs");
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([], { sid: "s-1", result: "kept" }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [missing] })]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true, JSON.stringify(res.coverage));
    equal(res.coverageFailed, undefined);
    equal(res.coverage.status, "incomplete");
    equal(res.coverage.missed.length, 1);
    ok(res.coverage.missed[0].includes("unreadable"), res.coverage.missed[0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The two PIN rows of the test plan live where they already were: a partial read
// stays ok (coverage.test.mjs "still incomplete after the re-ask"), and an
// unparseable transcript stays ok ("unparseable transcript on an ok leaf").
test("coverage: a partial read stays ok — the zero-engagement rule is about engagement, not read count", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: `s-${i + 1}`, result: "kept" }) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { mustRead: [F] })]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.output, "kept");
    equal(res.coverage.status, "incomplete");
    equal(res.coverageFailed, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
