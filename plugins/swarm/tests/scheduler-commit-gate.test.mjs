// The commit gate's scope and its run.log trail: only leaves that can edit files by
// their runner's own mechanism are judged, an unmeasurable tree counts as dirty, and
// a failure says why in run.log.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo, sentPrompt, streamOut, usageEnv, codexReading } from "./helpers/scheduler-fixtures.mjs";

const worktreeWith = (uncommitted, collects = []) => ({
  prepareIsolation: (t, cfg, resultsDir) => ({ path: join(resultsDir, "wt-impl"), branch: "swarm/impl", name: "impl", head: "h", repo: resultsDir, reused: false }),
  collect: (t, cfg, wt) => {
    collects.push(t.id);
    return { kept: true, branch: wt.branch, path: wt.path, diffstat: "1 file changed", uncommitted };
  },
});

const runLog = (resultsDir) => readFileSync(join(resultsDir, "run.log"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("an UNCOMMITTED_WORK failure carries its reason in the run.log state line", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({ output: streamOut(i ? "still editing" : "answer", "sess-note") }));
    const io = makeIo(spawn, { worktree: worktreeWith({ files: 2, commitsAhead: 1 }) });
    const p = plan(dir, [task("impl", { worktreeName: "impl", allowedTools: "Read,Edit,Bash" })]);
    await runPlan(p, CFG, io);
    const failed = runLog(p.resultsDir).find((e) => e.id === "impl" && e.state === "failed");
    ok(failed, "a failed state line is logged");
    equal(failed.note, "uncommitted: 2 files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unmeasurable tree is treated as dirty: re-asked, then failed saying it could not be measured", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({ output: streamOut(i ? "done" : "answer", "sess-unmeasured") }));
    const io = makeIo(spawn, { worktree: worktreeWith({ files: null, commitsAhead: 0 }) });
    const p = plan(dir, [task("impl", { worktreeName: "impl", allowedTools: "Read,Edit,Bash" })]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed", "git could not answer, so the leaf cannot pass");
    equal(spawn.calls.length, 2, "one commit re-ask before failing");
    const result = readResult(p.resultsDir, "impl");
    equal(result.errorCode, "UNCOMMITTED_WORK");
    ok(/could not be measured/.test(result.output), result.output);
    ok(/could not be measured/.test(sentPrompt(spawn.calls[1])), sentPrompt(spawn.calls[1]));
    const failed = runLog(p.resultsDir).find((e) => e.id === "impl" && e.state === "failed");
    equal(failed.note, "uncommitted: tree could not be measured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Bash-only leaf with uncommitted files is never re-asked or failed", async () => {
  const dir = tmp();
  const collects = [];
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("verdict", "sess-bash") }));
    const io = makeIo(spawn, { worktree: worktreeWith({ files: 1, commitsAhead: 0 }, collects) });
    const p = plan(dir, [task("verify", { worktreeName: "impl", allowedTools: "Read,Grep,Bash" })]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "ok");
    equal(spawn.calls.length, 1, "no commit re-ask");
    equal(collects.length, 1, "collected once, as before the gate existed");
    const result = readResult(p.resultsDir, "verify");
    equal(result.errorCode, undefined);
    equal(result.uncommitted, undefined);
    equal(r.worktreesKept[0].uncommitted, undefined, "its kept tree is listed exactly as before");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Write-only leaf is gated like an Edit leaf", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({ output: streamOut(i ? "done" : "answer", "sess-write") }));
    const io = makeIo(spawn, { worktree: worktreeWith({ files: 1, commitsAhead: 0 }) });
    const p = plan(dir, [task("impl", { worktreeName: "impl", allowedTools: "Read,Write" })]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed");
    equal(spawn.calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a NotebookEdit leaf is gated like an Edit leaf", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call, i) => ({ output: streamOut(i ? "done" : "answer", "sess-nb") }));
    const io = makeIo(spawn, { worktree: worktreeWith({ files: 1, commitsAhead: 0 }) });
    const p = plan(dir, [task("impl", { worktreeName: "impl", allowedTools: "Read,NotebookEdit" })]);
    const r = await runPlan(p, CFG, io);
    equal(r.summary.tasks[0].state, "failed");
    equal(spawn.calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex edits through apply_patch and its shell under workspace-write, so its sandbox
// — not its tool names — says whether it is an editor.
const codexStream = (text) => [
  JSON.stringify({ type: "thread.started", thread_id: "thread-gate" }),
  JSON.stringify({ type: "response.output_text.delta", delta: text }),
  JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
].join("\n") + "\n";

async function runCodexLeaf(dir, over, uncommitted) {
  const cwd = tmpdir();
  const cfg = { providers: { claude: { enabled: true }, ollama: { enabled: true, allowedRoots: [] }, codex: { enabled: true, path: "codex", allowedRoots: [cwd] } }, timeoutMs: 600000 };
  const spawn = fakeSpawnFactory((call, i) => ({ output: codexStream(i ? "committed" : "answer") }));
  const io = makeIo(spawn, { env: usageEnv({ codex: codexReading() }), worktree: worktreeWith(uncommitted) });
  const p = plan(dir, [task("impl", { model: "gpt-5-codex", provider: "codex", cwd, originalCwd: cwd, worktreeName: "impl", ...over })], { concurrency: 1 });
  const r = await runPlan(p, cfg, io);
  return { r, spawn, p };
}

test("a Codex leaf under workspace-write is judged even holding only Bash", async () => {
  const dir = tmp();
  try {
    const { r, spawn, p } = await runCodexLeaf(dir, { allowedTools: "Read,Grep,Glob,Bash" }, { files: 2, commitsAhead: 0 });
    equal(r.summary.tasks[0].state, "failed");
    equal(spawn.calls.length, 2, "one commit re-ask before failing");
    equal(readResult(p.resultsDir, "impl").errorCode, "UNCOMMITTED_WORK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Codex leaf on an explicit read-only sandbox is not judged, whatever its tool names", async () => {
  const dir = tmp();
  try {
    const { r, spawn } = await runCodexLeaf(dir, { allowedTools: "Read,Edit", sandbox: "read-only" }, { files: 2, commitsAhead: 0 });
    equal(r.summary.tasks[0].state, "ok");
    equal(spawn.calls.length, 1, "no commit re-ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
