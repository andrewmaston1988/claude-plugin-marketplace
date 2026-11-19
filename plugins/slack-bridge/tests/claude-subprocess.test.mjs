import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { buildClaudeInvocation, runClaude, killProcessTree } from "../src/core/claude-subprocess.mjs";

const PROXY = { url: "http://localhost:11434", authToken: "ollama" };

test("no model configured: no --model flag, no env overrides", () => {
  const { args, envOverrides } = buildClaudeInvocation({ prompt: "hi", model: null, proxy: PROXY });
  assert.equal(args.includes("--model"), false);
  assert.deepEqual(envOverrides, {});
});

test("claude model: --model passed, no env overrides", () => {
  for (const m of ["claude-sonnet-5", "haiku", "opus", "fable"]) {
    const { args, envOverrides } = buildClaudeInvocation({ prompt: "hi", model: m, proxy: PROXY });
    assert.equal(args[args.indexOf("--model") + 1], m);
    assert.deepEqual(envOverrides, {});
  }
});

test("open model: --model passed verbatim plus the env trio", () => {
  const { args, envOverrides } = buildClaudeInvocation({ prompt: "hi", model: "minimax-m3:cloud", proxy: PROXY });
  assert.equal(args[args.indexOf("--model") + 1], "minimax-m3:cloud");
  assert.deepEqual(envOverrides, {
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    ANTHROPIC_API_KEY: "ollama",
    ANTHROPIC_MODEL: "minimax-m3:cloud",
  });
});

test("open model without proxy config: falls back to ollama defaults", () => {
  const { envOverrides } = buildClaudeInvocation({ prompt: "hi", model: "glm-5.2:cloud" });
  assert.equal(envOverrides.ANTHROPIC_BASE_URL, "http://localhost:11434");
  assert.equal(envOverrides.ANTHROPIC_API_KEY, "ollama");
});

test("session resume and addDir survive alongside model", () => {
  const { args } = buildClaudeInvocation({
    prompt: "hi", sessionId: "s1", addDir: "C:/x", model: "glm-5.2:cloud", proxy: PROXY,
  });
  assert.equal(args[args.indexOf("--resume") + 1], "s1");
  assert.equal(args[args.indexOf("--add-dir") + 1], "C:/x");
});

// A child that never exits: the timeout is the only thing that settles the run.
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killCalls = 0;
  child.kill = () => { child.killCalls++; };
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("a timeout kills the process tree, not just the wrapper", async () => {
  const child = fakeChild(4242);
  const killed = [];
  await assert.rejects(
    runClaude({
      cwd: process.cwd(), prompt: "hi", timeoutMs: 20,
      _spawn: () => child,
      _killTree: (c) => { killed.push(c.pid); },
    }),
    /claude timed out after 20ms/,
  );
  assert.deepEqual(killed, [child.pid], "the timeout must tree-kill the spawned child by its PID");
  assert.equal(child.killCalls, 0, "child.kill only reaches the cmd.exe wrapper; the timeout owns the tree kill");
});

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function poll(pred, message, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = pred();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// The real shape on Windows: cmd.exe holds the session and a node grandchild does
// the work. child.kill reaps only cmd.exe, leaving the grandchild running.
test("the Windows tree kill leaves no live grandchild", {
  skip: process.platform !== "win32" ? "windows-only process tree" : false,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tree-kill-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const sleeper = path.join(dir, "sleeper.mjs");
  fs.writeFileSync(sleeper, [
    'import fs from "node:fs";',
    "fs.writeFileSync(process.argv[2], String(process.pid));",
    "setTimeout(() => {}, 60_000);",
  ].join("\n"));
  const wrapper = spawn("cmd.exe", ["/d", "/s", "/c", "node", sleeper, pidFile], { stdio: "ignore", windowsHide: true });
  let grandchild = null;
  try {
    grandchild = await poll(
      () => { try { return Number(fs.readFileSync(pidFile, "utf8")) || 0; } catch { return 0; } },
      "the grandchild never reported its PID",
    );
    assert.equal(isAlive(grandchild), true, "the grandchild should be running before the kill");

    killProcessTree(wrapper);

    await poll(() => !isAlive(grandchild), "the grandchild outlived the tree kill");
  } finally {
    if (grandchild) { try { process.kill(grandchild); } catch { /* already gone */ } }
    try { wrapper.kill(); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-line prompt is delivered via stdin, not as a -p argv element", () => {
  // cmd.exe /d /s /c parses argv line-by-line: a literal newline inside a
  // -p <prompt> element terminates the /c command and drops every arg after it
  // (--output-format, --model, --resume). The fix is --print + stdin delivery.
  const prompt = "line one\nline two";
  const { args } = buildClaudeInvocation({ prompt, model: null, proxy: PROXY });
  assert.equal(args.includes("-p"), false, "must not pass -p (cmd.exe /c cuts args at a newline)");
  assert.equal(args.includes(prompt), false, "prompt must not appear as an argv element");
  assert.equal(args.includes("--print"), true, "must use --print so the prompt is read from stdin");
});
