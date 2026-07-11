import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDispatch, toSpawnable, resolveExecutable } from "../src/dispatch.mjs";

const CFG = {
  provider: {
    mode: "env",
    url: "http://localhost:11434",
    authToken: "ollama",
    launchCmd: "ollama launch claude --model {model} -- {args}",
  },
};

const task = (over = {}) => ({
  id: "t", model: "haiku", allowedTools: "Read,Grep,Glob", ...over,
});

// Every dispatch asks for stream-json so the engine can extract the final
// result text and per-turn token usage. --verbose is required by -p.
const STREAM_FLAGS = ["--output-format", "stream-json", "--verbose"];

test("claude model: exact argv, no env overrides", () => {
  const d = buildDispatch(task({ model: "haiku", effort: "high" }), "the prompt", CFG);
  deepEqual(d.argv, ["claude", "-p", "the prompt", "--model", "haiku", "--effort", "high", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  deepEqual(d.env, {});
});

test("claude model without effort omits --effort", () => {
  const d = buildDispatch(task(), "p", CFG);
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "haiku", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
});

test("open model env mode: same argv plus exact env trio, model verbatim", () => {
  const d = buildDispatch(task({ model: "minimax-m3:cloud" }), "p", CFG);
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "minimax-m3:cloud", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  deepEqual(d.env, {
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    ANTHROPIC_API_KEY: "ollama",
    ANTHROPIC_MODEL: "minimax-m3:cloud",
  });
});

test("open model: effort passes through", () => {
  const d = buildDispatch(task({ model: "glm-4.6:cloud", effort: "xhigh" }), "p", CFG);
  ok(d.argv.includes("--effort"));
  equal(d.argv[d.argv.indexOf("--effort") + 1], "xhigh");
});

test("task.resume adds --resume <sessionId> for any model family", () => {
  const d = buildDispatch(task({ resume: "s-123" }), "follow-up", CFG);
  const i = d.argv.indexOf("--resume");
  ok(i > 0, d.argv.join(" "));
  equal(d.argv[i + 1], "s-123");
  const open = buildDispatch(task({ model: "glm-4.6:cloud", resume: "s-9" }), "q", CFG);
  ok(open.argv.includes("--resume"));
  equal(open.env.ANTHROPIC_MODEL, "glm-4.6:cloud");
});

test("no --max-budget-usd for any model family", () => {
  for (const m of ["haiku", "claude-opus-4-8", "glm-4.6:cloud"]) {
    const d = buildDispatch(task({ model: m }), "p", CFG);
    ok(!d.argv.includes("--max-budget-usd"), `--max-budget-usd leaked for ${m}`);
  }
  const launchCfg = { provider: { ...CFG.provider, mode: "launch" } };
  const d = buildDispatch(task({ model: "glm-4.6:cloud" }), "p", launchCfg);
  ok(!d.argv.includes("--max-budget-usd"));
});

test("launch mode: template split with {model} substitution and {args} splice", () => {
  const cfg = { provider: { ...CFG.provider, mode: "launch" } };
  const d = buildDispatch(task({ model: "qwen3-coder:cloud", effort: "high" }), "the prompt", cfg);
  deepEqual(d.argv, [
    "ollama", "launch", "claude", "--model", "qwen3-coder:cloud", "--",
    "-p", "the prompt", "--model", "qwen3-coder:cloud", "--effort", "high", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS,
  ]);
  deepEqual(d.env, {});
});

test("launch mode applies only to non-Claude models", () => {
  const cfg = { provider: { ...CFG.provider, mode: "launch" } };
  const d = buildDispatch(task({ model: "sonnet" }), "p", cfg);
  equal(d.argv[0], "claude");
  deepEqual(d.env, {});
});

test("cfg.claudePath overrides the executable", () => {
  const d = buildDispatch(task(), "p", { ...CFG, claudePath: "X:/bin/claude.exe" });
  equal(d.argv[0], "X:/bin/claude.exe");
});

// ── windows spawn resolution ──────────────────────────────────────────────────

test("toSpawnable peels a node .cmd shim, expanding %~dp0", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-shim-"));
  try {
    const cmdPath = join(dir, "claude.cmd");
    writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0claude-shim.mjs" %*\r\n`);
    const { cmd, args } = toSpawnable([cmdPath, "-p", "hi"]);
    equal(cmd, process.execPath);
    equal(args[0], join(dir, "claude-shim.mjs"));
    deepEqual(args.slice(1), ["-p", "hi"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toSpawnable falls back to cmd /c for an opaque .cmd", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-shim-"));
  try {
    const cmdPath = join(dir, "claude.cmd");
    writeFileSync(cmdPath, `@echo off\r\necho hello\r\n`);
    const { cmd, args } = toSpawnable([cmdPath, "-p", "hi"]);
    ok(/cmd(\.exe)?$/i.test(cmd));
    deepEqual(args, ["/d", "/s", "/c", cmdPath, "-p", "hi"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toSpawnable passes .exe and pathless resolution through untouched", { skip: process.platform !== "win32" }, () => {
  const r = toSpawnable(["C:\\bin\\claude.exe", "-p", "x"]);
  equal(r.cmd, "C:\\bin\\claude.exe");
  deepEqual(r.args, ["-p", "x"]);
});

test("resolveExecutable resolves a bare name via where on win32", { skip: process.platform !== "win32" }, () => {
  const fakeWhere = (cmd, args) => ({ status: 0, stdout: "C:\\somewhere\\claude.cmd\r\nC:\\other\\claude.exe\r\n" });
  equal(resolveExecutable("claude", { _spawnSync: fakeWhere }), "C:\\somewhere\\claude.cmd");
  const missing = () => ({ status: 1, stdout: "" });
  equal(resolveExecutable("claude", { _spawnSync: missing }), "claude");
});
