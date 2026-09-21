import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./helpers/repo-io.mjs";
import { buildDispatch, toSpawnable, windowsCommandLineLength } from "../src/dispatch.mjs";

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

test("win32 command-line check: with a .cmd launcher, the measured length includes the cmd /d /s /c wrapper", () => {
  const dir = tmp();
  try {
    const cmdPath = join(dir, "claude.cmd");
    writeFileSync(cmdPath, "@echo off\r\necho hello\r\n"); // opaque shim -> cmd /d /s /c fallback
    const cfg = { provider: { allowedRoots: [] }, providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } }, concurrency: 4, timeoutMs: 50000, resultInlineCap: 4000, claudePath: cmdPath };
    const baseTask = { id: "shim", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Grep,Glob" };
    // Find the prompt length where the WRAPPED command line just crosses the
    // cap but the bare (unwrapped) argv join would not — isolates that the
    // wrapper itself is what's being counted.
    let promptLen = 31000;
    let found = false;
    for (; promptLen < 32500; promptLen++) {
      const prompt = "x".repeat(promptLen);
      const { argv } = buildDispatch(baseTask, prompt, cfg);
      const bare = windowsCommandLineLength(argv);
      const { cmd, args } = toSpawnable(argv, { _platform: "win32" });
      const wrapped = windowsCommandLineLength([cmd, ...args]);
      if (bare <= 32000 && wrapped > 32000) { found = true; break; }
    }
    ok(found, "expected a prompt length where wrapping crosses the cap but the bare join doesn't");
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ ...baseTask, prompt: "x".repeat(promptLen) }],
    }));
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /task 'shim'/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
