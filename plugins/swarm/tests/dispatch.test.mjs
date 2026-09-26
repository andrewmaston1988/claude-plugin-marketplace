import { test } from "node:test";
import { equal, deepEqual, ok, throws, match } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildDispatch, toSpawnable, resolveExecutable, windowsCommandLineLength, mcpTools } from "../src/dispatch.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";

// The MCP roster is the operator's own machine; pin it out of argv assertions.
const NO_MCP = () => [];

const CFG = {
  provider: {
    mode: "env",
    url: "http://localhost:11434",
    authToken: "ollama",
    launchCmd: "ollama launch claude --model {model} -- {args}",
  },
};

const task = (over = {}) => ({
  id: "t", provider: "claude", model: "claude-haiku-4-5-20251001", effort: "medium", allowedTools: "Read,Grep,Glob", ...over,
});

// Every dispatch asks for stream-json so the engine can extract the final
// result text and per-turn token usage. --verbose is required by -p.
const STREAM_FLAGS = ["--output-format", "stream-json", "--verbose"];

test("claude model: exact argv, no env overrides", () => {
  const d = buildDispatch(task({ provider: "claude", model: "claude-haiku-4-5-20251001", effort: "high" }), "the prompt", CFG, { _mcpTools: NO_MCP });
  deepEqual(d.argv, ["claude", "-p", "the prompt", "--model", "claude-haiku-4-5-20251001", "--effort", "high", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  deepEqual(d.env, {});
});

test("claude model with the normalized default carries --effort", () => {
  const d = buildDispatch(task(), "p", CFG, { _mcpTools: NO_MCP });
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "claude-haiku-4-5-20251001", "--effort", "medium", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
});

test("open model env mode: same argv plus exact env trio, model verbatim", () => {
  const d = buildDispatch(task({ provider: "ollama", model: "minimax-m3:cloud" }), "p", CFG, { _mcpTools: NO_MCP });
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "minimax-m3:cloud", "--effort", "medium", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  deepEqual(d.env, {
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    ANTHROPIC_API_KEY: "ollama",
    ANTHROPIC_MODEL: "minimax-m3:cloud",
  });
});

test("contextWindow 1m suffixes only the CLI model name, keeping the provider model bare", () => {
  const d = buildDispatch(task({ provider: "ollama", model: "glm-5.3:cloud", contextWindow: "1m" }), "p", CFG, { _mcpTools: NO_MCP });
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "glm-5.3:cloud[1m]", "--effort", "medium", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  deepEqual(d.env, {
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    ANTHROPIC_API_KEY: "ollama",
    ANTHROPIC_MODEL: "glm-5.3:cloud",
  });
});

test("open model: effort passes through", () => {
  const d = buildDispatch(task({ provider: "ollama", model: "glm-4.6:cloud", effort: "xhigh" }), "p", CFG, { _mcpTools: NO_MCP });
  ok(d.argv.includes("--effort"));
  equal(d.argv[d.argv.indexOf("--effort") + 1], "xhigh");
});

test("task.resume adds --resume <sessionId> for any model family", () => {
  const d = buildDispatch(task({ resume: "s-123" }), "follow-up", CFG, { _mcpTools: NO_MCP });
  const i = d.argv.indexOf("--resume");
  ok(i > 0, d.argv.join(" "));
  equal(d.argv[i + 1], "s-123");
  const open = buildDispatch(task({ provider: "ollama", model: "glm-4.6:cloud", resume: "s-9" }), "q", CFG, { _mcpTools: NO_MCP });
  ok(open.argv.includes("--resume"));
  equal(open.env.ANTHROPIC_MODEL, "glm-4.6:cloud");
});

test("no --max-budget-usd for any model family", () => {
  for (const [provider, m] of [["claude", "claude-haiku-4-5-20251001"], ["claude", "claude-opus-4-8"], ["ollama", "glm-4.6:cloud"]]) {
    const d = buildDispatch(task({ provider, model: m }), "p", CFG, { _mcpTools: NO_MCP });
    ok(!d.argv.includes("--max-budget-usd"), `--max-budget-usd leaked for ${m}`);
  }
  const launchCfg = { provider: { ...CFG.provider, mode: "launch" } };
  const d = buildDispatch(task({ provider: "ollama", model: "glm-4.6:cloud" }), "p", launchCfg, { _mcpTools: NO_MCP });
  ok(!d.argv.includes("--max-budget-usd"));
});

test("launch mode: template split with {model} substitution and {args} splice", () => {
  const cfg = { provider: { ...CFG.provider, mode: "launch" } };
  const d = buildDispatch(task({ provider: "ollama", model: "qwen3-coder:cloud", effort: "high" }), "the prompt", cfg, { _mcpTools: NO_MCP });
  deepEqual(d.argv, [
    "ollama", "launch", "claude", "--model", "qwen3-coder:cloud", "--",
    "-p", "the prompt", "--model", "qwen3-coder:cloud", "--effort", "high", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS,
  ]);
  deepEqual(d.env, {});
});

test("launch mode refuses contextWindow because the launcher rejects suffixed model names", () => {
  const cfg = { provider: { ...CFG.provider, mode: "launch" } };
  throws(
    () => buildDispatch(task({ provider: "ollama", model: "glm-5.3:cloud", contextWindow: "1m" }), "p", cfg, { _mcpTools: NO_MCP }),
    /contextWindow "1m".*launch mode.*rejects \[1m\]/i
  );
});

test("launch mode applies only to non-Claude models", () => {
  const cfg = { provider: { ...CFG.provider, mode: "launch" } };
  const d = buildDispatch(task({ provider: "claude", model: "claude-sonnet-5" }), "p", cfg, { _mcpTools: NO_MCP });
  equal(d.argv[0], "claude");
  deepEqual(d.env, {});
});

test("task.settings adds --settings <json> right after --allowedTools", () => {
  const d = buildDispatch(task({ provider: "claude", model: "claude-sonnet-5", settings: { env: { X: "0" } } }), "p", CFG, { _mcpTools: NO_MCP });
  const i = d.argv.indexOf("--allowedTools");
  deepEqual(d.argv.slice(i, i + 4), ["--allowedTools", "Read,Grep,Glob", "--settings", '{"env":{"X":"0"}}']);
});

test("no settings key: exact argv, no --settings", () => {
  const d = buildDispatch(task(), "p", CFG, { _mcpTools: NO_MCP });
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "claude-haiku-4-5-20251001", "--effort", "medium", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  ok(!d.argv.includes("--settings"));
});

// ── disable1mContext (leaf context window) ──────────────────────────────────

test("disable1mContext: false + Claude model injects --settings with the 1M env var right after --allowedTools", () => {
  const cfg = { ...CFG, disable1mContext: false };
  const d = buildDispatch(task({ provider: "claude", model: "claude-sonnet-5" }), "p", cfg, { _mcpTools: NO_MCP });
  const i = d.argv.indexOf("--allowedTools");
  deepEqual(d.argv.slice(i, i + 4), ["--allowedTools", "Read,Grep,Glob", "--settings", '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"0"}}']);
});

test("disable1mContext: true + no task settings → no --settings (byte-identical to the shipped-default argv)", () => {
  const cfg = { ...CFG, disable1mContext: true };
  const d = buildDispatch(task({ provider: "claude", model: "claude-sonnet-5" }), "p", cfg, { _mcpTools: NO_MCP });
  deepEqual(d.argv, ["claude", "-p", "p", "--model", "claude-sonnet-5", "--effort", "medium", "--allowedTools", "Read,Grep,Glob", ...STREAM_FLAGS]);
  ok(!d.argv.includes("--settings"));
});

test("task settings.env.CLAUDE_CODE_DISABLE_1M_CONTEXT wins over the config default; other task settings keys survive the merge", () => {
  const cfg = { ...CFG, disable1mContext: false };
  const d = buildDispatch(task({ provider: "claude", model: "claude-sonnet-5", settings: { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", OTHER: "x" } } }), "p", cfg, { _mcpTools: NO_MCP });
  const i = d.argv.indexOf("--settings");
  deepEqual(JSON.parse(d.argv[i + 1]), { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", OTHER: "x" } });
});

test("disable1mContext: false on a non-Claude model injects nothing", () => {
  const cfg = { ...CFG, disable1mContext: false };
  const d = buildDispatch(task({ provider: "ollama", model: "minimax-m3:cloud" }), "p", cfg, { _mcpTools: NO_MCP });
  ok(!d.argv.includes("--settings"));
});

test("cfg.claudePath overrides the executable", () => {
  const d = buildDispatch(task(), "p", { ...CFG, claudePath: "X:/bin/claude.exe" }, { _mcpTools: NO_MCP });
  equal(d.argv[0], "X:/bin/claude.exe");
});

// ── engine writeRoots → provider translation ──────────────────────────────────

// The report digest states the engine's write INTENT as typed targets; Claude's
// primitive for confining a write is the injected PreToolUse guard, rooted at each
// target's own path — exact-file for a `file` target, subtree for a `directory`.
test("engine writeRoots reach Claude as the injected guard, rooted at every target path", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-writeroots-"));
  try {
    const scratch = join(dir, "run", "scratch-__digest");
    const report = join(dir, "run", "report.md");
    const d = buildDispatch(task({
      provider: "claude", model: "claude-sonnet-5",
      writeRoots: [{ path: scratch, kind: "directory" }, { path: report, kind: "file" }],
    }), "p", CFG, { _mcpTools: NO_MCP });
    const i = d.argv.indexOf("--settings");
    ok(i > 0, `the guard rides --settings: ${d.argv.join(" ")}`);
    const entry = JSON.parse(d.argv[i + 1]).hooks.PreToolUse[0];
    equal(entry.matcher, "Write|Edit|NotebookEdit");
    match(entry.hooks[0].command, /leaf-write-guard\.mjs/);
    ok(entry.hooks[0].command.includes(scratch), entry.hooks[0].command);
    ok(entry.hooks[0].command.includes(report), entry.hooks[0].command);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The engine's entry is PREPENDED, so a task's own hook cannot displace the guard
// that contains it — and unrelated settings survive the merge.
test("Claude: a task's own hooks and settings cannot displace the engine write guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-writeroots-"));
  try {
    const root = join(dir, "run");
    const own = { matcher: "Write", hooks: [{ type: "command", command: "echo own" }] };
    const d = buildDispatch(task({
      provider: "claude", model: "claude-sonnet-5",
      writeRoots: [{ path: root, kind: "directory" }],
      settings: { hooks: { PreToolUse: [own] }, env: { OTHER: "x" } },
    }), "p", CFG, { _mcpTools: NO_MCP });
    const settings = JSON.parse(d.argv[d.argv.indexOf("--settings") + 1]);
    equal(settings.hooks.PreToolUse.length, 2);
    match(settings.hooks.PreToolUse[0].hooks[0].command, /leaf-write-guard\.mjs/);
    deepEqual(settings.hooks.PreToolUse[1], own);
    equal(settings.env.OTHER, "x");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// An ordinary leaf carries no writeRoots, so its --settings behavior is untouched:
// no guard, and no --settings at all when it authored none.
test("an ordinary leaf with no writeRoots gets no guard and no --settings", () => {
  const d = buildDispatch(task(), "p", CFG, { _mcpTools: NO_MCP });
  ok(!d.argv.includes("--settings"));
});

test("Codex dispatch: provider registry selects exact fresh argv, runner, and parser", () => {
  const root = process.cwd();
  const cfg = {
    providers: {
      claude: { enabled: true },
      ollama: { enabled: true, allowedRoots: [root] },
      codex: { enabled: true, path: "codex", sandbox: "workspace-write", allowedRoots: [root] },
    },
  };
  const d = buildDispatch({
    provider: "codex", model: "gpt-5-codex", effort: "high", allowedTools: "Read,Edit,Bash",
    cwd: root, originalCwd: root, additionalDirs: ["C:/repo/shared"],
  }, "inspect the tree", cfg);
  deepEqual(d.argv, [
    "codex", "exec", "--json", "--model", "gpt-5-codex", "-c", 'model_reasoning_effort="high"',
    "--sandbox", "workspace-write", "--add-dir", "C:/repo/shared", "inspect the tree",
  ]);
  equal(d.runner, "codex");
  equal(d.parser, "codex");
  deepEqual(d.env, {});
});

test("Codex leaf with no manifest effort dispatches medium", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-dispatch-effort-"));
  try {
    const manifest = join(dir, "plan.json");
    writeFileSync(manifest, JSON.stringify({
      tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5.5", provider: "codex" }],
    }));
    const cfg = {
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, path: "codex", allowedRoots: [dir] },
      },
    };
    const plan = loadManifest(manifest, cfg, dir, {
      cache: [{ provider: "codex", model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] }],
    });
    equal(plan.tasks[0].effort, "medium");
    const d = buildDispatch({ ...plan.tasks[0], effort: undefined }, "inspect", cfg);
    equal(d.argv[d.argv.indexOf("model_reasoning_effort=\"medium\"") - 1], "-c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The engine's write targets reach Codex as native directory arguments: a `file`
// target contributes its containing directory, because --add-dir has no file-level
// equivalent. Anything already writable — the primary cwd — is not repeated.
test("Codex dispatch: writeRoots become workspace-write plus de-duplicated --add-dir pairs", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const run = join(dir, "run");
    const cfg = { providers: { codex: { enabled: true, path: "codex", sandbox: "workspace-write", allowedRoots: [dir] } } };
    const d = buildDispatch({
      provider: "codex", model: "gpt-5-codex", effort: "high", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      writeRoots: [
        { path: join(run, "scratch-__digest"), kind: "directory" },
        { path: join(run, "report.md"), kind: "file" },
        // already covered by the pair above — the file target's own directory
        { path: join(run, "report-again.md"), kind: "file" },
      ],
    }, "write the report", cfg);
    equal(d.argv[d.argv.indexOf("--sandbox") + 1], "workspace-write");
    const addDirs = d.argv.reduce((acc, v, i) => (v === "--add-dir" ? [...acc, d.argv[i + 1]] : acc), []);
    deepEqual(addDirs, [join(run, "scratch-__digest"), run]);
    equal(d.runner, "codex");
    equal(d.parser, "codex");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The adapter boundary is unchanged and deliberately so: an authored Claude-settings
// object is still refused on the Codex path, while the engine's typed targets are not.
test("Codex dispatch: authored settings are still refused, writeRoots are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const cfg = { providers: { codex: { enabled: true, path: "codex", allowedRoots: [dir] } } };
    const base = { provider: "codex", model: "gpt-5-codex", allowedTools: "Read", cwd: dir, originalCwd: dir };
    throws(
      () => buildDispatch({ ...base, settings: { env: { X: "1" } } }, "inspect", cfg),
      /Codex tasks do not accept Claude-only settings/
    );
    const d = buildDispatch({ ...base, allowedTools: "Read,Write", writeRoots: [{ path: join(dir, "run", "report.md"), kind: "file" }] }, "inspect", cfg);
    ok(d.argv.includes("--add-dir"), d.argv.join(" "));
    ok(!d.argv.includes("--settings"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex dispatch refuses contextWindow instead of ignoring it", () => {
  const root = process.cwd();
  const cfg = {
    providers: {
      codex: { enabled: true, path: "codex", allowedRoots: [root] },
    },
  };
  throws(
    () => buildDispatch({
      provider: "codex", model: "gpt-5-codex", contextWindow: "1m", allowedTools: "Read",
      cwd: root, originalCwd: root,
    }, "inspect", cfg),
    /Codex tasks do not support contextWindow/
  );
});

test("Codex dispatch: resume is native and safety gates run before invocation construction", () => {
  const root = process.cwd();
  const base = {
    provider: "codex", model: "gpt-5-codex", allowedTools: "Read", cwd: root, originalCwd: root,
  };
  const cfg = { providers: { codex: { enabled: true, path: "codex", allowedRoots: [root] } } };
  const resumed = buildDispatch({ ...base, resume: "thread-1" }, "follow up", cfg);
  equal(resumed.argv[resumed.argv.indexOf("--sandbox") + 1], "read-only");
  equal(resumed.argv[resumed.argv.indexOf("resume") + 1], "thread-1");
  equal(resumed.argv.at(-1), "follow up");

  throws(() => buildDispatch(base, "blocked", { providers: { codex: { enabled: false, allowedRoots: [root] } } }), /disabled/i);
  // A sibling of root, not a drive-letter literal: "C:/outside" is RELATIVE on posix,
  // so isUnderRoot resolves it under cwd and the gate never fires.
  const outside = resolve(root, "..", "swarm-outside-root");
  throws(() => buildDispatch({ ...base, cwd: outside, originalCwd: outside }, "blocked", cfg), /allowedRoots|governance/i);
});

// The sweep routes this through the shared resolver, so a provider armed ONLY at the top
// level must still be root-gated. Reading providers.<id>.allowedRoots directly leaves the
// top-level list silently ignored on the dispatch path.
test("dispatch: a provider armed only at the top level is still root-gated", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-dispatch-roots-"));
  try {
    const cfg = {
      allowedRoots: [root],
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, mode: "env", url: "http://127.0.0.1:1", authToken: "ollama" },
      },
    };
    const base = { provider: "ollama", model: "minimax-m3:cloud", allowedTools: "Read", cwd: root, originalCwd: root };
    equal(buildDispatch(base, "p", cfg).runner, "claude");
    const outside = resolve(root, "..", "swarm-outside-top-level-root");
    throws(() => buildDispatch({ ...base, cwd: outside, originalCwd: outside }, "blocked", cfg), /allowedRoots|governance/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// One rule across dispatch, ask.mjs and governance.mjs: every provider is root-gated,
// Claude included. Gating Claude is defence in depth — normalization's checkGovernance
// already refuses it — but the three layers must not disagree about who is exempt.
test("dispatch: a Claude task from outside allowedRoots is refused, like every other provider", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-dispatch-roots-"));
  try {
    const cfg = { allowedRoots: [root], providers: { claude: { enabled: true } } };
    const base = task({ cwd: root, originalCwd: root });
    equal(buildDispatch(base, "p", cfg, { _mcpTools: NO_MCP }).argv[0], "claude");
    const outside = resolve(root, "..", "swarm-claude-outside-root");
    throws(
      () => buildDispatch({ ...base, cwd: outside, originalCwd: outside }, "blocked", cfg, { _mcpTools: NO_MCP }),
      /allowedRoots|governance/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// An opaque .cmd cannot be peeled to a node script, and cmd.exe re-parses the argv it is
// handed — a prompt containing quotes comes out mangled. Refusing names what to fix instead.
test("toSpawnable refuses an opaque .cmd instead of routing it through cmd.exe", () => {
  const cmdPath = join(tmpdir(), "swarm-opaque-shim", "claude.cmd");
  const io = { _platform: "win32", _readFileSync: () => "@echo off\r\necho hello\r\n" };
  throws(
    () => toSpawnable([cmdPath, "-p", "hi"], io),
    (e) => e.message.includes(cmdPath) && /not a node shim/.test(e.message)
  );
  // An unreadable shim is no more peelable than an opaque one — same refusal, not a fallthrough.
  throws(
    () => toSpawnable([cmdPath, "-p", "hi"], { _platform: "win32", _readFileSync: () => { throw new Error("EACCES"); } }),
    (e) => e.message.includes(cmdPath) && /not a node shim/.test(e.message)
  );
});

test("toSpawnable passes .exe and pathless resolution through untouched", { skip: process.platform !== "win32" }, () => {
  const r = toSpawnable(["C:\\bin\\claude.exe", "-p", "x"]);
  equal(r.cmd, "C:\\bin\\claude.exe");
  deepEqual(r.args, ["-p", "x"]);
});

// ── windowsCommandLineLength (CreateProcess quoting) ───────────────────────────

test("windowsCommandLineLength: plain args join with single spaces, no quoting", () => {
  equal(windowsCommandLineLength(["claude", "-p", "hello", "--model", "claude-haiku-4-5-20251001"]), "claude -p hello --model claude-haiku-4-5-20251001".length);
});

test("windowsCommandLineLength: an arg with a space is wrapped in quotes", () => {
  equal(windowsCommandLineLength(["claude", "-p", "hello world"]), 'claude -p "hello world"'.length);
});

test("windowsCommandLineLength: quote characters double the cost (escaped, plus wrapping quotes)", () => {
  // a 4-char prompt of all quotes: each " becomes \" (2 chars), plus 2 wrapping quotes
  const len = windowsCommandLineLength(["claude", "-p", '""""']);
  // "claude -p " (10) + wrapping quote (1) + 4x(\") (8) + closing quote (1) = 20
  equal(len, 10 + 1 + 8 + 1);
});

test("windowsCommandLineLength: a trailing backslash before the closing quote is doubled", () => {
  // arg has a space (forces quoting) and ends in a backslash
  const len = windowsCommandLineLength(["claude", "-p", "a b\\"]);
  // quoted form: "a b\\" -> " a b \\ \\ " = 1 + 3 + 2 + 1 = 7, plus "claude -p " (10)
  equal(len, 10 + 7);
});

test("resolveExecutable resolves a bare name via where on win32", { skip: process.platform !== "win32" }, () => {
  const fakeWhere = (cmd, args) => ({ status: 0, stdout: "C:\\somewhere\\claude.cmd\r\nC:\\other\\claude.exe\r\n" });
  equal(resolveExecutable("claude", { _spawnSync: fakeWhere }), "C:\\somewhere\\claude.cmd");
  const missing = () => ({ status: 1, stdout: "" });
  equal(resolveExecutable("claude", { _spawnSync: missing }), "claude");
});

test("mcpTools names each configured server; a wildcard would grant nothing", () => {
  const read = () => JSON.stringify({ mcpServers: { scout: {}, context7: {} } });
  deepEqual(mcpTools(read), ["mcp__scout", "mcp__context7"]);
});

test("mcpTools is empty when the file is missing, unreadable or has no servers", () => {
  deepEqual(mcpTools(() => { throw new Error("ENOENT"); }), []);
  deepEqual(mcpTools(() => "not json"), []);
  deepEqual(mcpTools(() => JSON.stringify({})), []);
});

test("every leaf's allowedTools carries the MCP servers", () => {
  const fake = () => ["mcp__scout"];
  const d = buildDispatch({ provider: "claude", model: "claude-sonnet-5", allowedTools: "Read,Grep" }, "p", CFG, { _mcpTools: fake });
  equal(d.argv[d.argv.indexOf("--allowedTools") + 1], "Read,Grep,mcp__scout");
});

test("a leaf with no allowedTools still gets MCP, with no leading comma", () => {
  const fake = () => ["mcp__scout"];
  const d = buildDispatch({ provider: "claude", model: "claude-sonnet-5", allowedTools: "" }, "p", CFG, { _mcpTools: fake });
  equal(d.argv[d.argv.indexOf("--allowedTools") + 1], "mcp__scout");
});
