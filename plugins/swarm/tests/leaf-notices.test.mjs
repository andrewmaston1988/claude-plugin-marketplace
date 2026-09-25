// The engine's own prompt text: every leaf is told its output contract, and a
// codex leaf is told what tools it actually has. Both failures were silent —
// findings left mid-transcript, and a codex leaf refusing a Claude tool list.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";

// The notices verbatim: these literals are the spec, so a wording change is a
// deliberate edit here, never a silent drift in the engine.
const FINAL = "Only your FINAL message is recorded as your result — put every finding in it; nothing said earlier is kept.";
const codexLine = (sandbox) =>
  `You have no Read/Grep/Glob/Edit/Write tools here — a shell only. Where this prompt names them, use shell commands (type/cat, rg/findstr, sed -n); your sandbox is ${sandbox}.`;

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

const CODEX_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-notices" }),
  JSON.stringify({ type: "response.output_text.delta", delta: "codex answer" }),
  JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
].join("\n") + "\n";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-notices-"));
}

function task(id, over = {}) {
  return {
    id,
    prompt: `do ${id}`,
    provider: "claude",
    model: "claude-haiku-4-5-20251001",
    allowedTools: "Read,Grep,Glob",
    cwd: over.cwd || tmpdir(),
    originalCwd: over.cwd || tmpdir(),
    timeoutMs: 5000,
    after: [],
    ...over,
  };
}

function plan(dir, tasks, over = {}) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "", ...over };
}

// The string the runner was actually given — claude rides `-p`, codex takes it
// positionally. Never strips: these assertions are about the notice itself.
function sentPrompt(call) {
  const args = call.args ?? call.argv;
  const i = args.indexOf("-p");
  return i >= 0 ? args[i + 1] : args[args.length - 1];
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("every claude leaf's prompt ends with the final-message notice", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const p = plan(dir, [task("a", { prompt: "author text" })]);
    await runPlan(p, CFG, makeIo(spawn));
    equal(sentPrompt(spawn.calls[0]), `author text\n\n${FINAL}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ollama models run through the claude runner, so they get the same notice and
// never the codex tool line.
test("an ollama leaf gets the notice and no codex tool line", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const p = plan(dir, [task("o", { provider: "ollama", model: "glm-4.6:cloud", prompt: "author text" })]);
    await runPlan(p, CFG, makeIo(spawn));
    equal(sentPrompt(spawn.calls[0]), `author text\n\n${FINAL}`);
    ok(!sentPrompt(spawn.calls[0]).includes("no Read/Grep/Glob"), "no codex line on a claude-runner leaf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("author text stays first and byte-identical, even after substitution", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => sentPrompt(call).startsWith("produce") ? { output: "SUNK" } : { output: "ok" });
    const p = plan(dir, [
      task("src", { prompt: "produce" }),
      task("sink", { prompt: "got: {{result:src}}", after: ["src"] }),
    ]);
    await runPlan(p, CFG, makeIo(spawn));
    equal(sentPrompt(spawn.calls[1]), `got: SUNK\n\n${FINAL}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [allowedTools, sandbox] of [["Read,Grep,Glob", "read-only"], ["Read,Grep,Glob,Bash", "workspace-write"]]) {
  test(`a codex leaf is told it has a shell only, sandbox ${sandbox}`, async () => {
    const dir = tmp();
    const cwd = tmpdir();
    try {
      const cfg = {
        providers: {
          claude: { enabled: true },
          ollama: { enabled: true, allowedRoots: [] },
          codex: { enabled: true, path: "codex", allowedRoots: [cwd] },
        },
        timeoutMs: 600000,
      };
      const spawn = fakeSpawnFactory(() => ({ output: CODEX_STREAM }));
      const p = plan(dir, [task("cx", {
        model: "gpt-5-codex", provider: "codex", cwd, originalCwd: cwd, allowedTools, prompt: "author text",
      })]);
      const r = await runPlan(p, cfg, makeIo(spawn));
      equal(r.summary.tasks[0].state, "ok", "the codex leaf must still complete");
      equal(sentPrompt(spawn.calls[0]), `author text\n\n${FINAL}\n${codexLine(sandbox)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A forEach clone carries promptFinal, so it never re-runs the launch-time
// substitution pass — and must still be told exactly once.
test("a forEach clone carries the notice exactly once", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => sentPrompt(call).startsWith("produce") ? { output: '["a","b"]' } : { output: "ok" });
    const p = plan(dir, [
      task("src", { prompt: "produce" }),
      task("fix", { prompt: "fix {{item}}", after: ["src"], forEach: { from: "src", path: "", maxItems: 5 } }),
    ]);
    await runPlan(p, CFG, makeIo(spawn));
    const clones = spawn.calls.filter((c) => sentPrompt(c).startsWith("fix "));
    equal(clones.length, 2);
    for (const call of clones) {
      equal(occurrences(sentPrompt(call), FINAL), 1, "the engine never repeats itself");
      ok(sentPrompt(call).endsWith(FINAL));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt that already carries the block is not given it twice", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const p = plan(dir, [task("a", { prompt: `author text\n\n${FINAL}`, promptFinal: true })]);
    await runPlan(p, CFG, makeIo(spawn));
    equal(sentPrompt(spawn.calls[0]), `author text\n\n${FINAL}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results/<id>.json records the prompt the leaf actually saw", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const p = plan(dir, [task("a", { prompt: "author text" })]);
    await runPlan(p, CFG, makeIo(spawn));
    equal(readResult(p.resultsDir, "a").prompt, sentPrompt(spawn.calls[0]));
    equal(readResult(p.resultsDir, "a").prompt, `author text\n\n${FINAL}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
