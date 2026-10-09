import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./helpers/repo-io.mjs";
import { buildDispatch, windowsCommandLineLength } from "../src/dispatch.mjs";
import { withLeafNotices } from "../src/leaf-notices.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cmdline-"));
}

// ── win32 command-line-length check (swarm-long-prompts) ──────────────────────
// A leaf's prompt is passed as a command-line argument (dispatch.mjs's
// buildDispatch: "-p", prompt). Windows caps a whole command line at 32,767
// characters — a leaf over that can never spawn (ENAMETOOLONG). validate
// catches it before anything spends.

test("win32 command-line check: a 40,000-char prompt fails, naming the task, its length and the file-pointer fix", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "long", prompt: "x".repeat(40000), provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'long'/.test(e.message) && /command line/.test(e.message) &&
        /\d{5}/.test(e.message) && /point the leaf at a file/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: the same manifest loads fine on linux (platform injected)", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "long", prompt: "x".repeat(40000), provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    const plan = loadManifest(p, cfg, dir, { io: { platform: "linux" } });
    equal(plan.tasks[0].id, "long");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: a 31,000-char prompt plus a long allowedTools list together exceed the cap", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    const bigTools = Array.from({ length: 200 }, (_, i) => `Tool${i}`).join(",");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "combo", prompt: "x".repeat(31000), provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: bigTools }],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'combo'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: a {{result:x}} placeholder is measured at resultInlineCap characters, not its raw template text", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 40000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "a", prompt: "look", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "b", prompt: "use {{result:a}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["a"] },
      ],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'b'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: a 20,000-char prompt of quote characters fails (quoting doubles it past the cap)", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    writeFileSync(p, JSON.stringify({ tasks: [{ id: "quotey", prompt: '"'.repeat(20000), provider: "claude", model: "claude-haiku-4-5-20251001" }] }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'quotey'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: the engine's notice is measured, so a prompt that fits alone can still be refused", () => {
  const dir = tmp();
  try {
    const p = join(dir, "plan.json");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe" };
    // cwd is required: Claude is root-gated at dispatch like every other provider.
    const task = { id: "edge", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Grep,Glob", cwd: dir, originalCwd: dir };
    const len = (text) => windowsCommandLineLength(buildDispatch({ ...task, prompt: text }, text, cfg).argv);
    // The line grows 1:1 with an all-x prompt, so one measurement lands on the cap.
    const n = 30000 + (32000 - len("x".repeat(30000)));
    ok(len("x".repeat(n)) <= 32000, "the author's prompt alone fits under the cap");
    ok(len(withLeafNotices("x".repeat(n), task, cfg, "claude")) > 32000, "the notice is what tips it over");
    writeFileSync(p, JSON.stringify({ tasks: [{ ...task, prompt: "x".repeat(n) }] }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'edge'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A codex leaf with mustRead is dispatched with a list of read-plan part files in its
// prompt — at most READS_PART_CEILING of them, and validate cannot resolve mustRead to
// know how many (the worktree does not exist yet). So it measures the ceiling, and a
// prompt with room to spare for the ordinary notice is still refused.
test("win32 command-line check: a codex leaf with mustRead is measured with its read-plan list", () => {
  const dir = tmp();
  try {
    const cfg = {
      provider: { allowedRoots: [] },
      providers: {
        claude: { enabled: true, allowedRoots: [tmpdir()] },
        codex: { enabled: true, path: "C:\\fake\\codex.exe", allowedRoots: [dir] },
      },
      concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: "C:\\fake\\claude.exe",
    };
    const task = {
      id: "reader", provider: "codex", model: "gpt-5-codex", allowedTools: "Read,Bash",
      cwd: dir, originalCwd: dir, mustRead: ["a.mjs"],
    };
    // The ceiling the launch caps itself at, as paths: RESULT_PATH_MEASURE_LEN each.
    const atCeiling = Array.from({ length: 12 }, () => "x".repeat(260));
    const len = (n, reads) => windowsCommandLineLength(
      buildDispatch({ ...task, prompt: "x".repeat(n) }, withLeafNotices("x".repeat(n), task, cfg, "codex", reads), cfg).argv,
    );
    // One probe gives the line's cost, a second how much of it an all-x prompt accounts
    // for; 100 characters of headroom below the cap then lands the two cases either side.
    const perChar = (len(20000, undefined) - len(19000, undefined)) / 1000;
    const n = 20000 + Math.floor((31900 - len(20000, undefined)) / perChar);
    ok(len(n, undefined) <= 32000, "the author's prompt plus the base notice fits");
    ok(len(n, atCeiling) > 32000, "the read-plan list is what tips it over");
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ tasks: [{ ...task, prompt: "x".repeat(n) }] }));
    throws(
      () => loadManifest(join(dir, "plan.json"), cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'reader'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An opaque .cmd has no measurable command line to count: it cannot be peeled to a node
// script, so the budget check's own resolution refuses it — naming the launcher, at
// validate time, before anything spends.
test("win32 command-line check: an opaque .cmd launcher is refused at validate, naming it", () => {
  const dir = tmp();
  try {
    const cmdPath = join(dir, "claude.cmd");
    writeFileSync(cmdPath, "@echo off\r\necho hello\r\n");
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: cmdPath };
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "shim", prompt: "look", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Grep,Glob" }],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => e.message.includes(cmdPath) && /not a node shim/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
