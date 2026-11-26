// The check's place in the leaf contract: every otherwise-successful exit runs it,
// a terminal rejection keeps the diagnostics already computed, a stop stays a stop,
// and the approval surface names every checked leaf — child manifests included.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { enforceLeafContract } from "../src/scheduler/leaf-contract.mjs";
import { CONTRACT_CHECK_REASKS } from "../src/scheduler/leaf-contract.mjs";
import { boundedSink, runCheck } from "../src/scheduler/check-run.mjs";
import { validateCheckExecutables } from "../src/manifest-dispatch-budget.mjs";
import { makeDefaultIo } from "../src/scheduler/run-task.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";
import { CFG, plan, task } from "./helpers/scheduler-fixtures.mjs";
import { runCliInProcess } from "./helpers/cli.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const CHECK = ["node", "check-report.mjs", "{output}"];
const dirOf = () => mkdtempSync(join(tmpdir(), "swarm-check-contract-"));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const writeLines = (dir, name, n) => { const p = join(dir, name); writeFileSync(p, "x\n".repeat(n)); return p; };

const SITE = {
  type: "object", required: ["file", "line", "quote"],
  properties: { file: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } },
};
const SITES = { type: "object", required: ["sites"], properties: { sites: { type: "array", items: SITE } } };

// One claude leaf's stdout. `sid: null` omits the init event, which is what leaves
// the engine without a session to re-ask; a read turn makes the coverage parser see it.
let seq = 0;
function leafOut({ reads = [], sid = "s-1", result = "done" } = {}) {
  const lines = [];
  if (sid) lines.push(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
  if (reads.length) {
    const ids = reads.map(() => `t${seq++}`);
    lines.push(JSON.stringify({
      type: "assistant",
      message: {
        id: `m${seq++}`, stop_reason: "end_turn",
        content: reads.map((r, i) => ({ type: "tool_use", id: ids[i], name: "Read", input: { file_path: r.file, offset: r.offset, limit: r.limit } })),
      },
    }));
    lines.push(JSON.stringify({
      type: "user",
      message: { content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: false, content: "" })) },
    }));
  }
  lines.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }));
  return lines.join("\n") + "\n";
}

// Leaf answers in order; the checker answers from `check(index)`; a `{exit: 1}`
// leaf answer is a re-ask process that died.
function harness(answers, check = () => ({ exit: 0 })) {
  let leaf = 0;
  let checked = 0;
  const spawn = fakeSpawnFactory((call) => {
    if (call.cmd === "node") return check(checked++);
    const at = Math.min(leaf, answers.length - 1);
    leaf += 1;
    const a = answers[at];
    return a.output !== undefined ? { output: a.output, exit: a.exit ?? 0 } : a;
  });
  return { spawn, calls: spawn.calls, leaves: () => leaf, checks: () => checked };
}

const leafPrompts = (h) => h.calls.filter((c) => c.cmd !== "node").map(promptOf);

// ── every successful exit runs the check ──────────────────────────────────────

test("contract: a coverage shortfall that cannot be re-asked still runs the check", async () => {
  const dir = dirOf();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const h = harness(
      [{ output: leafOut({ reads: [{ file: F, offset: 1, limit: 2000 }], sid: null, result: "partial" }) }],
      () => ({ exit: 1, output: "no Findings section" }),
    );
    const p = plan(dir, [task("a", { cwd: dir, mustRead: [F], check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(h.checks(), 1, "the check ran on the answer that could not be re-asked");
    equal(res.ok, false, "an unchecked answer must not be recorded ok");
    equal(res.checkFailed, true);
    ok(res.output.includes("no Findings section"), res.output);
  } finally { cleanup(dir); }
});

test("contract: a failed coverage re-ask does not ship the first answer unchecked", async () => {
  const dir = dirOf();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const h = harness(
      [
        { output: leafOut({ reads: [{ file: F, offset: 1, limit: 2000 }] }) },
        { exit: 1, output: "leaf died" },
      ],
      () => ({ exit: 1, output: "no Findings section" }),
    );
    const p = plan(dir, [task("a", { cwd: dir, mustRead: [F], check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(h.checks(), 1, "the first pass was checked even though its correction never ran");
    equal(res.ok, false);
    equal(res.checkFailed, true);
  } finally { cleanup(dir); }
});

// ── a rejection keeps what the engine already computed ────────────────────────

test("contract: an exhausted check carries read coverage and citation stats", async () => {
  const dir = dirOf();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    writeFileSync(join(dir, "src.txt"), "hello world\n");
    const answer = leafOut({
      reads: [{ file: F, offset: 1, limit: 2000 }],
      result: JSON.stringify({ sites: [{ file: "src.txt", line: 1, quote: "hello world" }] }),
    });
    const h = harness([...Array(6)].map(() => ({ output: answer })), () => ({ exit: 1, output: "no Findings" }));
    const p = plan(dir, [task("a", { cwd: dir, returns: SITES, mustRead: [F], check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    equal(res.checkFailed, true);
    ok(res.output.includes("no Findings"), "the checker's message is still the diagnostic");
    ok(res.rawOutput, "the leaf's own answer is still kept");
    equal(res.citations.checked, 1, "citation verification rides the failed result");
    equal(res.coverage.status, "incomplete", "read coverage rides the failed result");
    ok(res.coverage.missedItems >= 1, JSON.stringify(res.coverage));
  } finally { cleanup(dir); }
});

test("contract: a check-only retry does not mark the coverage event retried", async () => {
  const dir = dirOf();
  try {
    const F = writeLines(dir, "small.mjs", 10);
    const answer = leafOut({ reads: [{ file: F, offset: 1, limit: 10 }], result: "answer" });
    const h = harness([{ output: answer }, { output: answer }], (i) => (i === 0 ? { exit: 1, output: "no Findings" } : { exit: 0 }));
    const p = plan(dir, [task("a", { cwd: dir, mustRead: [F], check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    equal(readResult(p.resultsDir, "a").ok, true);
    const events = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l)).filter((e) => e.event === "coverage");
    equal(events.length, 1, "the passing answer is the only one that reaches the coverage log");
    equal(events[0].retried, false, "coverage was complete on the first turn");
    ok(leafPrompts(h).some((p2) => p2.includes("output check rejected")), "the check re-ask did fire");
  } finally { cleanup(dir); }
});

// ── a stop is a stop ───────────────────────────────────────────────────────────

test("contract: a run stopped during its check is not recorded as a check failure", async () => {
  const dir = dirOf();
  try {
    const resultsDir = join(dir, "run");
    mkdirSync(join(resultsDir, "results"), { recursive: true });
    const spawn = fakeSpawnFactory(() => ({ delayMs: 60_000 }));
    const io = makeIo(spawn);
    const res = await enforceLeafContract(
      task("a", { cwd: dir, check: CHECK }),
      { ok: true, exit: 0, output: "answer", sessionId: "s-1", durationMs: 1, tokens: { input: 1, output: 1 } },
      dir, resultsDir, CFG, io, () => ({}), { isCancelled: () => true }, async () => { throw new Error("no re-ask in a stopped run"); },
    );
    equal(res.ok, false);
    equal(res.checkFailed, undefined, "a stopped check is not a defect the leaf must correct");
    ok(/stopped/i.test(res.output), res.output);
  } finally { cleanup(dir); }
});

// ── the checker's own plumbing ─────────────────────────────────────────────────

test("contract: a checker's output is bounded while every chunk is still drained", () => {
  const sink = boundedSink(100);
  for (let i = 0; i < 10_000; i++) sink.push("x".repeat(64) + ".");
  equal(sink.text().length, 100, "only the capped prefix is retained");
  ok(sink.text().startsWith("x".repeat(64)), "the retained prefix is the first bytes emitted");
});

test("contract: a wrapper spawn refusal names check[0]", async () => {
  const dir = dirOf();
  try {
    const io = {
      ...makeDefaultIo(),
      spawn: () => { throw new Error("cannot spawn 'x.cmd': it is not a node shim"); },
    };
    const v = await runCheck(
      { id: "a", check: ["C:/opt/x.cmd", "{output}"] },
      "answer", { cwd: dir, resultsDir: join(dir, "run"), cfg: CFG, io, deadlineMs: 5000 },
    );
    equal(v.outcome, "broken");
    ok(v.text.includes("check[0] 'C:/opt/x.cmd'"), v.text);
  } finally { cleanup(dir); }
});

test("contract: validate refuses a check executable Windows cannot spawn", () => {
  const dir = dirOf();
  try {
    const cmd = join(dir, "wrapper.cmd");
    writeFileSync(cmd, "@echo off\r\nnot-a-node-shim.exe %*\r\n");
    const errors = [];
    validateCheckExecutables(
      [{ id: "rev", check: [cmd, "{output}"] }],
      { platform: "win32" }, errors, (t) => `task '${t.id}'`,
    );
    equal(errors.length, 1, errors.join("\n"));
    ok(errors[0].includes(`check[0] '${cmd}'`) && /real executable/.test(errors[0]), errors[0]);
  } finally { cleanup(dir); }
});

// ── validate names every checked leaf ─────────────────────────────────────────

function repo(tasks, childTasks) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-check-contract-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: childTasks }));
  const path = join(dir, "m.json");
  writeFileSync(path, JSON.stringify({ tasks }));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { claude: { enabled: true, allowedRoots: [dir] } } }));
  return { dir, path, env: { SWARM_HOME: home } };
}

const leafTask = (over = {}) => ({ id: "lane", prompt: "do it", provider: "claude", model: MODEL, ...over });

test("contract: validate announces checks inside a child manifest under the run's ids", async () => {
  const w = repo(
    [{ id: "wave", manifest: "child.json" }],
    [leafTask({ id: "gate", check: CHECK })],
  );
  try {
    const r = await runCliInProcess(["validate", w.path], { cwd: w.dir, env: w.env });
    equal(r.status, 0, r.stderr);
    const line = r.stdout.split("\n").find((l) => l.startsWith("output check:"));
    ok(line, r.stdout);
    ok(line.includes("wave~gate"), line);
    ok(line.includes(`up to ${CONTRACT_CHECK_REASKS} corrective re-asks`), "the budget is the enforced one");
  } finally { cleanup(w.dir); }
});
