// The output check: a manifest-named argv command that holds a leaf's answer to a
// contract of its own — its re-asks spend a budget the schema's and coverage's never touch.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { taskKey, reusable } from "../src/task-key.mjs";
import { makeDefaultIo } from "../src/scheduler/run-task.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";
import { CFG, plan, streamOut, task } from "./helpers/scheduler-fixtures.mjs";
import { runCliInProcess } from "./helpers/cli.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const CHECK = ["node", "check-report.mjs", "{output}"];
const dirOf = () => mkdtempSync(join(tmpdir(), "swarm-check-"));

const RETURNS = {
  type: "object",
  required: ["findings"],
  properties: { findings: { type: "array", items: { type: "string" } }, note: { type: "string" } },
};
const SITE = {
  type: "object", required: ["file", "line", "quote"],
  properties: { file: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } },
};
const SITES = { type: "object", required: ["sites"], properties: { sites: { type: "array", items: SITE } } };

// A leaf answers from `answers` in order; the checker answers from `check(index)`.
// The command is the one discriminator: a leaf dispatches as claude, a check as node.
function harness(answers, check = () => ({ exit: 0 }), onCheck) {
  let leaf = 0;
  let checked = 0;
  const spawn = fakeSpawnFactory((call) => {
    if (call.cmd === "node") {
      const i = checked++;
      onCheck?.(i, call);
      return check(i, call) || { exit: 0 };
    }
    const at = Math.min(leaf, answers.length - 1);
    leaf += 1;
    return answers[at];
  });
  return { spawn, calls: spawn.calls, leaves: () => leaf, checks: () => checked };
}

const leafPrompts = (h) => h.calls.filter((c) => c.cmd !== "node").map(promptOf);
const checkFileArg = (call) => call.args.find((a) => String(a).endsWith(".check.txt"));
const checkCorrections = (h) => leafPrompts(h).filter((p) => p?.includes("output check rejected")).length;
const schemaCorrections = (h) => leafPrompts(h).filter((p) => p?.includes("did not match the task's returns schema")).length;

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// ── the check runs at all ─────────────────────────────────────────────────────

test("row 1: a prose task with check alone runs its check once and finishes ok on exit 0", async () => {
  const dir = dirOf();
  try {
    const h = harness([{ output: streamOut("the answer", "s-1") }]);
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })]);
    const r = await runPlan(p, CFG, makeIo(h.spawn));
    equal(r.summary.tasks[0].state, "ok");
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.output, "the answer");
    equal(res.checkFailed, undefined);
    equal(h.checks(), 1, "the check runs once");
    equal(h.leaves(), 1, "a passing check spends no leaf turn");
  } finally { cleanup(dir); }
});

test("row 2: exit 1 re-asks the leaf with the checker's capped output; a passing answer is the result", async () => {
  const dir = dirOf();
  try {
    const noisy = "A".repeat(5000) + "TAILMARK";
    const h = harness(
      [{ output: streamOut("first", "s-1") }, { output: streamOut("second", "s-2") }],
      (i) => (i === 0 ? { exit: 1, output: noisy } : { exit: 0 }),
    );
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.output, "second");
    equal(h.checks(), 2);
    equal(h.leaves(), 2, "exactly one corrective turn");
    const retry = leafPrompts(h)[1];
    ok(retry.includes("A".repeat(200)), "the checker's own output is the correction");
    ok(!retry.includes("TAILMARK"), "the correction is capped at resultInlineCap");
  } finally { cleanup(dir); }
});

test("row 3: three rejections fail the leaf with checkFailed, the diagnostic and its own answer as rawOutput", async () => {
  const dir = dirOf();
  try {
    const h = harness(
      ["one", "two", "three", "four"].map((t, i) => ({ output: streamOut(t, `s-${i}`) })),
      () => ({ exit: 1, output: "still no Findings section" }),
    );
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })]);
    const r = await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    equal(res.checkFailed, true);
    ok(res.output.includes("still no Findings section"), res.output);
    equal(res.rawOutput, "four", "the leaf's own answer is kept for a corrective re-run");
    equal(r.summary.tasks[0].state, "failed");
    equal(h.checks(), 4, "one check per answer, three re-asks spent");
    equal(h.leaves(), 4);
  } finally { cleanup(dir); }
});

test("row 4: a rejection with no session id, and a re-ask process that fails, each end ok:false with checkFailed", async () => {
  const dir = dirOf();
  try {
    const noSession = harness(
      [{ output: streamOut("first", null) }],
      () => ({ exit: 1, output: "no Findings" }),
    );
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })]);
    await runPlan(p, { ...CFG, concurrency: 1 }, makeIo(noSession.spawn));
    const a = readResult(p.resultsDir, "a");
    equal(a.ok, false);
    equal(a.checkFailed, true);
    equal(noSession.leaves(), 1, "nothing to resume — no re-ask is attempted");

    const deadReask = harness(
      [{ output: streamOut("first", "s-1") }, { exit: 1, output: "leaf died" }],
      () => ({ exit: 1, output: "no Findings" }),
    );
    const p2 = plan(`${dir}-b`, [task("b", { cwd: dir, check: CHECK })]);
    await runPlan(p2, CFG, makeIo(deadReask.spawn));
    const b = readResult(p2.resultsDir, "b");
    equal(b.ok, false);
    equal(b.checkFailed, true);
  } finally { cleanup(dir); cleanup(`${dir}-b`); }
});

test("row 5: a re-run of a check-failed leaf resumes on the correction instead of re-sending the prompt", async () => {
  const dir = dirOf();
  try {
    const first = harness(
      ["one", "two", "three", "four"].map((t, i) => ({ output: streamOut(t, `s-${i}`) })),
      () => ({ exit: 1, output: "no Findings" }),
    );
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })]);
    await runPlan(p, CFG, makeIo(first.spawn));
    equal(readResult(p.resultsDir, "a").checkFailed, true);

    const second = harness([{ output: streamOut("unused", "s-9") }], () => ({ exit: 0 }));
    const r = await runPlan(p, CFG, makeIo(second.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.checkFailed, undefined);
    equal(second.leaves(), 0, "the correction is re-checked in place — the prompt is never re-sent");
    equal(res.output, "four");
    equal(r.summary.tasks[0].state, "ok");
  } finally { cleanup(dir); }
});

// ── a broken checker fails at once ────────────────────────────────────────────

test("row 6: exit 2 fails the leaf at once with no re-ask", async () => {
  const dir = dirOf();
  try {
    const h = harness([{ output: streamOut("first", "s-1") }], () => ({ exit: 2, output: "checker crashed" }));
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    equal(res.checkFailed, true);
    ok(res.output.includes("checker crashed"), res.output);
    equal(h.leaves(), 1, "a broken command cannot be fixed by re-asking the model");
  } finally { cleanup(dir); }
});

test("row 6: a missing executable is broken, not a rejection", async () => {
  const { runCheck } = await import("../src/scheduler/check-run.mjs");
  const dir = dirOf();
  try {
    const v = await runCheck(
      { id: "a", check: ["definitely-not-a-real-command-xyz", "{output}"] },
      "answer", { cwd: dir, resultsDir: join(dir, "run"), cfg: CFG, io: makeDefaultIo(), deadlineMs: 5000 },
    );
    equal(v.outcome, "broken", v.text);
    ok(/could not start|ENOENT/i.test(v.text), v.text);
  } finally { cleanup(dir); }
});

test("row 6: a checker past the deadline is broken and its process tree is killed", async () => {
  const { runCheck } = await import("../src/scheduler/check-run.mjs");
  const dir = dirOf();
  try {
    const script = join(dir, "hang.mjs");
    const pidFile = join(dir, "kid.pid");
    writeFileSync(script, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "writeFileSync(process.argv[2], String(kid.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const v = await runCheck(
      { id: "a", check: [process.execPath, script, pidFile] },
      "answer", { cwd: dir, resultsDir: join(dir, "run"), cfg: CFG, io: makeDefaultIo(), deadlineMs: 1500 },
    );
    equal(v.outcome, "broken", v.text);
    ok(/timed out/i.test(v.text), v.text);
    const kid = Number(readFileSync(pidFile, "utf8"));
    ok(kid > 0, "the hung checker started a child");
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = Date.now() + 5000;
    while (alive(kid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    equal(alive(kid), false, "the checker's child process is gone");
  } finally { cleanup(dir); }
});

test("row 7: a results path with a space reaches the checker as one argument", async () => {
  const dir = dirOf();
  try {
    let seen = null;
    const h = harness([{ output: streamOut("answer", "s-1") }], () => ({ exit: 0 }), (i, call) => { seen = checkFileArg(call); });
    const spaced = join(dir, "run dir");
    const p = plan(dir, [task("a", { cwd: dir, check: CHECK })], { resultsDir: spaced });
    await runPlan(p, CFG, makeIo(h.spawn));
    ok(seen && seen.includes(" "), `the path is one argument, spaces intact: ${seen}`);
    equal(seen, join(spaced, "results", "a.check.txt"));
    ok(existsSync(seen), "the checker was handed a real file");
  } finally { cleanup(dir); }
});

// ── budgets and ordering ──────────────────────────────────────────────────────

test("row 8: a check rejection does not spend the returns budget", async () => {
  const dir = dirOf();
  try {
    const h = harness(
      [
        { output: streamOut('{"findings":[]}', "s-1") },
        { output: streamOut("not json", "s-2") },
        { output: streamOut("not json", "s-3") },
        { output: streamOut("not json", "s-4") },
        { output: streamOut('{"findings":["done"]}', "s-5") },
      ],
      (i) => (i === 0 ? { exit: 1, output: "empty findings" } : { exit: 0 }),
    );
    const p = plan(dir, [task("a", { cwd: dir, returns: RETURNS, check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true, res.output);
    equal(schemaCorrections(h), 3, "all three schema re-asks survive a check re-ask");
  } finally { cleanup(dir); }
});

test("row 8: a schema miss does not spend the check's budget", async () => {
  const dir = dirOf();
  try {
    const h = harness(
      [
        { output: streamOut("not json", "s-1") },
        { output: streamOut('{"findings":[]}', "s-2") },
        { output: streamOut('{"findings":[]}', "s-3") },
        { output: streamOut('{"findings":[]}', "s-4") },
        { output: streamOut('{"findings":["ok"]}', "s-5") },
      ],
      (i) => (i < 3 ? { exit: 1, output: "empty findings" } : { exit: 0 }),
    );
    const p = plan(dir, [task("a", { cwd: dir, returns: RETURNS, check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true, res.output);
    equal(h.checks(), 4, "three check re-asks fired after a schema re-ask");
  } finally { cleanup(dir); }
});

test("row 8: a citation refuted after a check re-ask still gets its one correction", async () => {
  const dir = dirOf();
  try {
    writeFileSync(join(dir, "src.txt"), "hello world\n");
    const h = harness(
      [
        { output: streamOut(JSON.stringify({ sites: [{ file: "src.txt", line: 1, quote: "hello world" }] }), "s-1") },
        { output: streamOut(JSON.stringify({ sites: [{ file: "src.txt", line: 1, quote: "nowhere in the file" }] }), "s-2") },
        { output: streamOut(JSON.stringify({ sites: [{ file: "src.txt", line: 1, quote: "hello world" }] }), "s-3") },
      ],
      (i) => (i === 0 ? { exit: 1, output: "sites must be ordered" } : { exit: 0 }),
    );
    const p = plan(dir, [task("a", { cwd: dir, returns: SITES, check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true, res.output);
    ok(leafPrompts(h).some((p2) => p2.includes("could not be verified")), "the refutation still earns its correction");
  } finally { cleanup(dir); }
});

test("row 9: schema-failing output never reaches the check; a returns task's check reads the validated JSON", async () => {
  const dir = dirOf();
  try {
    const seen = [];
    const h = harness(
      [{ output: streamOut("not json", "s-1") }, { output: streamOut('{"findings":["one"],"note":null}', "s-2") }],
      () => ({ exit: 0 }),
      (i, call) => { seen.push(readFileSync(checkFileArg(call), "utf8")); },
    );
    const p = plan(dir, [task("a", { cwd: dir, returns: RETURNS, check: CHECK })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    equal(h.leaves(), 2, "one schema re-ask, no check on the invalid answer");
    equal(seen.length, 1, "the check ran only on the schema-clean answer");
    equal(seen[0], '{"findings":["one"]}', "the validated value, nulls dropped, before citation annotation");
    equal(readResult(p.resultsDir, "a").ok, true);
  } finally { cleanup(dir); }
});

test("row 10: a changed check re-runs on resume; a legacy keyless result is not reused for a checked task", async () => {
  const dir = dirOf();
  try {
    const checked = task("a", { cwd: dir, check: CHECK });
    ok(taskKey(checked) !== taskKey({ ...checked, check: ["node", "other.mjs", "{output}"] }), "check is in the key");
    equal(reusable({ ok: true }, checked), false, "keyless results predate checks");
    equal(reusable({ ok: true }, task("b")), true, "an unchecked task keeps today's legacy reuse");

    const first = harness([{ output: streamOut("answer", "s-1") }]);
    const p = plan(dir, [checked]);
    await runPlan(p, CFG, makeIo(first.spawn));
    equal(readResult(p.resultsDir, "a").ok, true);

    writeFileSync(join(p.resultsDir, "results", "a.json"), JSON.stringify({ id: "a", ok: true, output: "answer" }));
    const second = harness([{ output: streamOut("answer", "s-1") }]);
    await runPlan(p, CFG, makeIo(second.spawn));
    equal(second.leaves(), 1, "a keyless result does not suppress a checked task");

    const rewritten = harness([{ output: streamOut("answer", "s-1") }]);
    const p3 = plan(`${dir}-c`, [{ ...checked, cwd: dir }]);
    await runPlan(p3, CFG, makeIo(rewritten.spawn));
    const again = harness([{ output: streamOut("answer", "s-1") }]);
    await runPlan(p3, CFG, makeIo(again.spawn));
    equal(again.leaves(), 0, "an unchanged check reuses its result");
  } finally { cleanup(dir); cleanup(`${dir}-c`); }
});

// ── validate ──────────────────────────────────────────────────────────────────

function repo(tasks, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-check-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: [{ id: "k", prompt: "x", provider: "claude", model: MODEL }] }));
  const path = join(dir, "m.json");
  writeFileSync(path, JSON.stringify({ tasks, ...extra }));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { claude: { enabled: true, allowedRoots: [dir] } } }));
  return { dir, path, env: { SWARM_HOME: home } };
}

const leafTask = (over = {}) => ({ id: "lane", prompt: "do it", provider: "claude", model: MODEL, ...over });

test("row 11: validate rejects a bad check shape and check on agentless nodes, naming the field and an example", async () => {
  const w = repo([
    leafTask({ id: "shape", check: "node check.mjs {output}" }),
    leafTask({ id: "noout", check: ["node", "check.mjs"] }),
    { id: "m", manifest: "child.json", check: CHECK },
    { id: "cmp", compute: "1 + 1", check: CHECK },
    leafTask({ id: "w", allowedTools: "Read,Edit" }),
    { id: "int", integrate: { into: "feat", from: ["w"] }, after: ["w"], check: CHECK },
  ]);
  try {
    const r = await runCliInProcess(["validate", w.path], { cwd: w.dir, env: w.env });
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/check must be a non-empty array of strings/.test(r.stderr), r.stderr);
    ok(/\{output\}/.test(r.stderr) && /e\.g\./.test(r.stderr), `the error teaches the fix:\n${r.stderr}`);
    ok(/manifest task is an agentless container/.test(r.stderr) && /check/.test(r.stderr), r.stderr);
    ok(/compute tasks are agentless/.test(r.stderr) && /check/.test(r.stderr), r.stderr);
    ok(/integrate tasks are agentless/.test(r.stderr) && /check/.test(r.stderr), r.stderr);
  } finally { cleanup(w.dir); }
});

test("row 12: validate names a task carrying check alone", async () => {
  const w = repo([leafTask({ id: "rev", check: CHECK })]);
  try {
    const r = await runCliInProcess(["validate", w.path], { cwd: w.dir, env: w.env });
    equal(r.status, 0, r.stderr);
    const line = r.stdout.split("\n").find((l) => l.includes("output check"));
    ok(line, r.stdout);
    ok(line.includes("rev"), line);
  } finally { cleanup(w.dir); }
});

// ── regression guard ─────────────────────────────────────────────────────────

test("row 13: a task without check behaves exactly as today", async () => {
  const dir = dirOf();
  try {
    const h = harness([{ output: streamOut("plain answer", "s-1") }]);
    const p = plan(dir, [task("a", { cwd: dir })]);
    await runPlan(p, CFG, makeIo(h.spawn));
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.output, "plain answer");
    equal(res.checkFailed, undefined);
    equal(h.calls.length, 1, "no extra child is spawned");
    ok(!existsSync(join(p.resultsDir, "results", "a.check.txt")), "nothing is written for an unchecked task");
  } finally { cleanup(dir); }
});
