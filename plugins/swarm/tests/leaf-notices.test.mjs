// The engine's own prompt text: every leaf is told its output contract, and a
// codex leaf is told what tools it actually has. Both failures were silent —
// findings left mid-transcript, and a codex leaf refusing a Claude tool list.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { withLeafNotices, withoutLeafNotices, leafNotices } from "../src/leaf-notices.mjs";
import { fakeSpawnFactory, makeIo, sentPrompt, usageEnv, codexReading } from "./helpers/fake-io.mjs";

// The notices verbatim: these literals are the spec, so a wording change is a
// deliberate edit here, never a silent drift in the engine.
const FINAL = "Only your FINAL message is recorded as your result — put every finding in it; nothing said earlier is kept.";
// Two variants, one per platform: the codex sandbox kills every MSYS2 program on
// Windows (CreateFileMapping … Win32 error 5), so the POSIX line steers a win32 leaf
// into tools that cannot start. The engine host picks which one it sends.
const codexLinePosix = (sandbox) =>
  `You have no Read/Grep/Glob/Edit/Write tools here — a shell only. Where this prompt names them, use shell commands (type/cat, rg/findstr, sed -n); your sandbox is ${sandbox}.`;
const codexLineWin32 = (sandbox) =>
  `You have no Read/Grep/Glob/Edit/Write tools here — a shell only. Where this prompt names them, use PowerShell (Get-Content, rg, findstr) — Git's bash, sed, cat and grep cannot start in the codex sandbox; your sandbox is ${sandbox}.`;
const codexLine = (sandbox, platform = process.platform) =>
  platform === "win32" ? codexLineWin32(sandbox) : codexLinePosix(sandbox);

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

// A write-capable codex task is given a worktree, so its cwd must be a repo.
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-notices-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  return repo;
}

// These assertions are about the notice itself, so they read the raw prompt:
// `sentPrompt` never strips where `promptOf` does.
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
    // Only a write-capable leaf is given a worktree, so only that case needs a repo.
    const cwd = allowedTools.includes("Bash") ? initRepo() : tmp();
    // Codex preflight reads the meter before it dispatches, so the home it reads
    // must already hold a reading — otherwise the run spawns the real codex.
    const env = usageEnv({ codex: codexReading() });
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
      const r = await runPlan(p, cfg, makeIo(spawn, { env }));
      equal(r.summary.tasks[0].state, "ok", "the codex leaf must still complete");
      equal(sentPrompt(spawn.calls[0]), `author text\n\n${FINAL}\n${codexLine(sandbox)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ── the win32 codex line ─────────────────────────────────────────────────────
// The sandbox that kills MSYS2 is the one on the engine host, so the host picks
// the variant: a win32 leaf told to use `sed -n` is told to run a command that
// cannot start.

test("win32: the codex notice names only tools the sandbox can start, and says why", () => {
  const line = leafNotices({ runner: "codex", sandbox: "read-only", platform: "win32" });
  equal(line, `${FINAL}\n${codexLineWin32("read-only")}`);
  ok(!line.includes("sed -n"), "never steers a win32 leaf at an MSYS tool");
});

test("linux: the codex notice is the line it always was", () => {
  equal(leafNotices({ runner: "codex", sandbox: "read-only", platform: "linux" }), `${FINAL}\n${codexLinePosix("read-only")}`);
  equal(leafNotices({ runner: "claude", sandbox: "read-only", platform: "win32" }), FINAL, "no tool line off the codex runner");
});

test("a codex block written on either platform strips, and is never told twice", () => {
  for (const platform of ["win32", "linux"]) {
    const told = `author text\n\n${FINAL}\n${codexLine("read-only", platform)}`;
    equal(withoutLeafNotices(told), "author text", `${platform}: stripped`);
    equal(withLeafNotices(told, { allowedTools: "Read,Grep,Glob" }, {}, "codex"), told, `${platform}: not told twice`);
  }
});

// ── the read-plan files ───────────────────────────────────────────────────────
// A codex leaf batches its first command past the model-visible cap and never sees
// the files it was told to read. The engine writes the plan to part files and names
// them in the notice, so the leaf runs one command per call from the start.
// The head is the spec — a wording change is a deliberate edit here.
const READS_HEAD =
  "Your required reads are listed in the files below — run every command in them, one command per call, before you answer:";
const readsBlock = (files) => `${READS_HEAD}\n${files.map((f) => `  - ${f}`).join("\n")}`;

test("a codex leaf handed read-plan files is told to run every command in them", () => {
  const files = ["C:/run/results/a.reads-1.txt", "C:/run/results/a.reads-2.txt"];
  equal(
    withLeafNotices("author text", { allowedTools: "Read,Grep,Glob" }, {}, "codex", files),
    `author text\n\n${FINAL}\n${codexLine("read-only")}\n${readsBlock(files)}`,
  );
});

test("a leaf with no read-plan files gets the notice it always got", () => {
  const told = withLeafNotices("author text", { allowedTools: "Read,Grep,Glob" }, {}, "codex", []);
  equal(told, `author text\n\n${FINAL}\n${codexLine("read-only")}`);
  equal(withLeafNotices("author text", { allowedTools: "Read,Grep,Glob" }, {}, "codex"), told);
});

test("a claude leaf is never handed a read-plan list — its reads are Read calls", () => {
  equal(withLeafNotices("author text", {}, {}, "claude", ["C:/run/a.reads-1.txt"]), `author text\n\n${FINAL}`);
});

test("the notice names at most 12 parts, and says so when the plan is longer", () => {
  // The dispatch budget measures a 12-part list; a launch that could send 13 would
  // send a notice longer than the one that was measured.
  const files = Array.from({ length: 13 }, (_, i) => `C:/run/results/a.reads-${i + 1}.txt`);
  const told = withLeafNotices("author text", { allowedTools: "Read,Grep,Glob" }, {}, "codex", files);
  const tail = told.slice(told.indexOf(READS_HEAD));
  equal(occurrences(tail, "  - C:/run/results/a.reads-"), 12);
  ok(tail.startsWith(readsBlock(files.slice(0, 12))), tail);
  ok(tail.includes("more reads than this notice can list"), tail);
});

test("a codex block carrying read-plan files strips whole, and is never told twice", () => {
  const files = ["C:/run/results/a.reads-1.txt", "C:/run/results/a.reads-2.txt"];
  for (const platform of ["win32", "linux"]) {
    const told = `author text\n\n${FINAL}\n${codexLine("read-only", platform)}\n${readsBlock(files)}`;
    equal(withoutLeafNotices(told), "author text", `${platform}: stripped`);
    equal(withLeafNotices(told, { allowedTools: "Read,Grep,Glob" }, {}, "codex", files), told, `${platform}: not told twice`);
  }
});

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

// The anchor's words are the author's too. Only the block at the TAIL is the
// engine's, so a prompt quoting it mid-text is told once and read back whole.
test("a prompt quoting the anchor mid-text keeps it, and still gets the block at the tail", async () => {
  const dir = tmp();
  try {
    const authored = `read this:\n\n${FINAL}\nthen act`;
    const spawn = fakeSpawnFactory(() => ({ output: "done" }));
    const p = plan(dir, [task("a", { prompt: authored })]);
    await runPlan(p, CFG, makeIo(spawn));
    const sent = sentPrompt(spawn.calls[0]);
    ok(sent.endsWith(`\n\n${FINAL}`), "the engine's block still lands last");
    equal(withoutLeafNotices(sent), authored, "the author's own words survive the strip");
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

// A codex block ends with its tool line, not the anchor — it must still read as the block.
test("a codex prompt carrying its block is neither told twice nor left unstripped", () => {
  const told = `author text\n\n${FINAL}\n${codexLine("read-only")}`;
  equal(withLeafNotices(told, { allowedTools: "Read,Grep,Glob" }, {}, "codex"), told);
  equal(withoutLeafNotices(told), "author text");
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
