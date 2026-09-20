import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CONTEXT_WINDOW_1M } from "./contracts.mjs";
import { isClaudeModel } from "./models.mjs";
import { deepMerge } from "./config.mjs";
import { providerConfig } from "./providers.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";
import { createRunnerRegistry } from "./runners.mjs";
import { defaultCodexRunnerAdapter } from "./codex.mjs";
import { isUnderRoot } from "./roots.mjs";
import { runnerParserFactories } from "./stream.mjs";

// Build the argv + env for one task dispatch. Pure — no process interaction.
//
// Claude-family models: plain `claude -p … --model <m> [--effort <e>] --allowedTools <t>`.
// Non-Claude models, mode "env" (default): the SAME argv plus the pipeline-proven
// env trio pointing Claude Code at the provider's Anthropic-format endpoint.
// Non-Claude models, mode "launch": argv built from cfg.provider.launchCmd template.
//
// `--max-budget-usd` is NEVER added, for any model: non-Claude dispatch routes
// through a proxy where real cost is $0 but Claude Code would still meter
// Anthropic pricing on token counts and trip the ceiling mid-task; Claude
// dispatch is interactive-supervised, so the manifest preview is the budget gate.
// Every configured MCP server as an allow rule. Servers must be named: `mcp__*` is
// skipped with a warning in an allow rule, so a wildcard grants nothing.
export function mcpTools(_read = () => readFileSync(join(homedir(), ".claude.json"), "utf8")) {
  try {
    return Object.keys(JSON.parse(_read()).mcpServers || {}).map((s) => `mcp__${s}`);
  } catch { return []; }
}

function buildClaudeInvocation(task, prompt, cfg, providerId, _mcpTools = mcpTools) {
  const claudePath = cfg.claudePath || "claude";
  const ollama = providerConfig(cfg, "ollama");
  // disable1mContext: false means the CONFIG default is the 1M window; a task's
  // own `settings` still wins (deepMerge, task second) so a leaf can opt back
  // out (or in) regardless of the operator's default.
  const base = providerId === "claude" && isClaudeModel(task.model) && cfg.disable1mContext === false
    ? { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" } }
    : null;
  const settings = base || task.settings ? deepMerge(base || {}, task.settings || {}) : null;
  // `[1m]` is matched by the CLI on the model name; provider endpoints still need
  // the bare id, so this suffix must never reach ANTHROPIC_MODEL.
  const cliModel = task.contextWindow === CONTEXT_WINDOW_1M ? `${task.model}[1m]` : task.model;
  // stream-json lets the engine extract the final result text and per-turn
  // token usage from stdout; --verbose is mandatory with -p for this format.
  const claudeArgs = [
    "-p", prompt,
    "--model", cliModel,
    ...(task.effort ? ["--effort", task.effort] : []),
    // MCP goes to every leaf: the roster is the operator's own, and a leaf that loses
    // scout falls back to grepping the tree.
    "--allowedTools", [task.allowedTools, ..._mcpTools()].filter(Boolean).join(","),
    // A shell env var LOSES to the user's settings.json env block, and Claude Code
    // has no [1m] model alias — --settings is highest-precedence in the CLI's
    // settings chain, so it's the only route that overrides that block per-leaf.
    ...(settings ? ["--settings", JSON.stringify(settings)] : []),
    // interrogation path: continue an existing leaf session (`swarm ask`)
    ...(task.resume ? ["--resume", task.resume] : []),
    "--output-format", "stream-json", "--verbose",
  ];

  if (providerId === "claude") {
    return { argv: [claudePath, ...claudeArgs], env: {}, runner: "claude", parser: "claude" };
  }

  if (ollama.mode === "launch") {
    if (task.contextWindow === CONTEXT_WINDOW_1M) {
      throw new Error('contextWindow "1m" is unsupported with Ollama launch mode because the launcher rejects [1m] model names; use env mode or remove contextWindow');
    }
    // Template like "ollama launch claude --model {model} -- {args}":
    // {model} substitutes in place; the {args} token splices the claude args.
    const argv = [];
    for (const token of String(ollama.launchCmd).split(/\s+/).filter(Boolean)) {
      if (token === "{args}") argv.push(...claudeArgs);
      else argv.push(token.replaceAll("{model}", cliModel));
    }
    return { argv, env: {}, runner: "claude", parser: "claude" };
  }

  // env mode: model name passes through verbatim (`minimax-m3:cloud`-style).
  return {
    argv: [claudePath, ...claudeArgs],
    env: {
      ANTHROPIC_BASE_URL: ollama.url,
      ANTHROPIC_API_KEY: ollama.authToken,
      ANTHROPIC_MODEL: task.model,
    },
    runner: "claude",
    parser: "claude",
  };
}

function dispatchRunners(providerRegistry) {
  return createRunnerRegistry([
    { id: "claude", buildInvocation: (task, prompt, context = {}) => buildClaudeInvocation(task, prompt, context.config || {}, context.provider || "claude", context.mcpTools) },
    defaultCodexRunnerAdapter,
  ], { providerRegistry });
}

export function createDispatchRegistry({ providerRegistry, runnerRegistry } = {}) {
  const providers = providerRegistry || defaultProviderRegistry();
  return {
    providerRegistry: providers,
    runnerRegistry: runnerRegistry || dispatchRunners(providers),
  };
}

function dispatchCache(task, cfg, options) {
  if (Array.isArray(options?.cache)) return options.cache;
  if (Array.isArray(cfg?.modelCache)) return cfg.modelCache;
  if (Array.isArray(cfg?.models)) return cfg.models;
  return [];
}

function validateDispatchPolicy(task, identity, adapter, cfg) {
  const problems = adapter.validateTask({ ...task, ...identity }, { config: cfg, task });
  if (Array.isArray(problems) && problems.length) {
    throw new Error(`provider '${identity.provider}' rejected task: ${problems.join("; ")}`);
  }
  if (identity.provider === "codex" && task.contextWindow !== undefined) {
    throw new Error('provider \'codex\' rejected task: Codex tasks do not support contextWindow; "1m" is a Claude CLI model-name suffix');
  }
  if (identity.provider === "codex" && task.leafGuard && task.leafGuard !== false) {
    throw new Error("provider 'codex' cannot run a configured leaf guard; set leafGuard: false for this task");
  }
  const roots = providerConfig(cfg, identity.provider).allowedRoots;
  // Legacy hand-built configs predate canonical provider blocks. Keep their
  // Ollama dispatch byte-compatible, while canonical and Codex configs always
  // opt into the fail-closed root gate. An empty legacy list means "not
  // configured"; an explicit canonical empty list remains fail-closed.
  const canonicalBlock = cfg?.providers?.[identity.provider] && typeof cfg.providers[identity.provider] === "object";
  const rootGate = identity.provider === "codex" || canonicalBlock || (Array.isArray(roots) && roots.length > 0);
  const cwd = task.originalCwd || task.cwd;
  if (rootGate && identity.provider !== "claude" && (!cwd || !Array.isArray(roots) || !roots.some((root) => isUnderRoot(cwd, root)))) {
    throw new Error(
      `governance: provider '${identity.provider}' model '${identity.model}' cannot dispatch from '${cwd}' — ` +
      `cwd is not under any providers.${identity.provider}.allowedRoots entry`
    );
  }
}

// Build the provider-aware invocation + runner/parser identity for one task.
// Pure — no process interaction. The scheduler still consumes only argv/env; a
// caller may drive its stream loop from the returned runner/parser directly.
export function buildDispatch(task, prompt, cfg = {}, options = {}) {
  const { providerRegistry, runnerRegistry } = createDispatchRegistry(options);
  const identity = providerRegistry.resolve(task, {
    cache: dispatchCache(task, cfg, options),
    config: cfg,
  });
  const adapter = providerRegistry.get(identity.provider);
  validateDispatchPolicy(task, identity, adapter, cfg);
  const provider = { ...identity, runnerId: adapter.runnerId };
  const runner = runnerRegistry.resolve(provider);
  if (typeof runner.buildInvocation !== "function") {
    throw new Error(`runner '${runner.id}' does not provide buildInvocation()`);
  }
  const invocation = runner.buildInvocation(
    { ...task, ...identity }, prompt,
    // _mcpTools is the test seam: options is where it rides now that the 4th
    // positional belongs to the provider registry.
    { config: cfg, provider: identity.provider, mcpTools: options._mcpTools }
  );
  const parser = runner.parser || runner.parserId || runner.id;
  if (!runnerParserFactories.has(String(parser).toLowerCase())) {
    throw new Error(`runner '${runner.id}' has no registered parser '${parser}'`);
  }
  return {
    ...invocation,
    provider: identity.provider,
    model: identity.model,
    runner: runner.id,
    parser,
  };
}

// The runner whose transcript a leaf produces; only "claude" stream-json is
// understood by mustRead, anything else fails closed at validate. Every model runs
// through the claude CLI except a launch-mode wrapper that isn't claude — its
// stdout is unknown, so the wrapper's name is returned to trigger the rejection.
export function runnerOf(task, cfg) {
  if (isClaudeModel(task.model)) return "claude";
  if (cfg?.provider?.mode === "launch") {
    const first = String(cfg.provider.launchCmd || "").trim().split(/\s+/).filter(Boolean)[0] || "";
    const bin = first.replace(/\.(exe|cmd|bat|com)$/i, "").split(/[\\/]/).pop();
    return bin.toLowerCase() === "claude" ? "claude" : (bin || "unknown");
  }
  return "claude"; // env mode dispatches the claude CLI verbatim
}

// ── Windows spawn resolution ──────────────────────────────────────────────────
// Node's spawn() rejects .bat/.cmd directly (EINVAL), and shell:true would let
// cmd.exe re-parse the args — mangling any prompt containing quotes. Following
// the pipeline precedent: resolve the command via PATH, and when it lands on a
// .cmd/.bat that is a thin `node "<script>" %*` wrapper, peel it and invoke
// node directly with the underlying script (supports %~dp0 self-relative paths).
// Anything else falls back to `cmd /c` (fine for argv without quotes).

export function resolveExecutable(cmd, { _spawnSync = spawnSync, _env = process.env, _platform = process.platform, _cache } = {}) {
  if (_platform !== "win32") return cmd;
  if (isAbsolute(cmd) || cmd.includes(sep) || cmd.includes("/")) return cmd;
  if (_cache?.has(cmd)) return _cache.get(cmd);
  const r = _spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true, timeout: 5000, env: _env });
  let resolved = cmd;
  if (r.status === 0 && r.stdout) {
    const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // `where` also lists extensionless files (e.g. a POSIX sh shim next to its
    // .cmd twin) — those aren't spawnable on Windows, so prefer real executables.
    resolved = lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) || lines[0] || cmd;
  }
  _cache?.set(cmd, resolved);
  return resolved;
}

// CreateProcess argv quoting (the same rule cmd.exe/CommandLineToArgvW use):
// an argument with no space/tab/quote passes through bare; otherwise it's
// quoted, with a run of backslashes doubled only when it precedes a quote
// (embedded or closing) and a literal quote escaped by one backslash. Used by
// manifest.mjs's win32 command-line-length check — a plain space-join would
// undercount a quote-heavy prompt, since quoting can more than double it.
function quoteArgWin(arg) {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const c of arg) {
    if (c === "\\") {
      backslashes++;
    } else if (c === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + c;
      backslashes = 0;
    }
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

export function windowsCommandLineLength(argv) {
  return argv.map(quoteArgWin).join(" ").length;
}

export function toSpawnable(argv, { _readFileSync = readFileSync, _spawnSync = spawnSync, _env = process.env, _platform = process.platform, _cache } = {}) {
  let [cmd, ...args] = argv;
  if (_platform !== "win32") return { cmd, args };
  cmd = resolveExecutable(cmd, { _spawnSync, _env, _platform, _cache });
  if (!/\.(bat|cmd)$/i.test(cmd)) return { cmd, args };
  try {
    const content = _readFileSync(cmd, "utf8");
    const m = content.match(/node(?:\.exe)?\s+"([^"]+)"\s+%\*/i);
    if (m && m[1]) {
      const script = m[1].replace(/%~dp0/gi, dirname(cmd) + sep);
      return { cmd: process.execPath, args: [script, ...args] };
    }
  } catch { /* unreadable shim — fall through to cmd /c */ }
  return { cmd: _env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", cmd, ...args] };
}
