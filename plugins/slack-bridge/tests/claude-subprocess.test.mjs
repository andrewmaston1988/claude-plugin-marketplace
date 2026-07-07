import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeInvocation } from "../src/core/claude-subprocess.mjs";

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
