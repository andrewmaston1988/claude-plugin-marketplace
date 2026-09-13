import { readFileSync } from "node:fs";
import { dirname, sep, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { isClaudeModel } from "./models.mjs";
import { deepMerge } from "./config.mjs";

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
export function buildDispatch(task, prompt, cfg) {
  const claudePath = cfg.claudePath || "claude";
  // disable1mContext: false means the CONFIG default is the 1M window; a task's
  // own `settings` still wins (deepMerge, task second) so a leaf can opt back
  // out (or in) regardless of the operator's default.
  const base = isClaudeModel(task.model) && cfg.disable1mContext === false
    ? { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" } }
    : null;
  const settings = base || task.settings ? deepMerge(base || {}, task.settings || {}) : null;
  // stream-json lets the engine extract the final result text and per-turn
  // token usage from stdout; --verbose is mandatory with -p for this format.
  const claudeArgs = [
    "-p", prompt,
    "--model", task.model,
    ...(task.effort ? ["--effort", task.effort] : []),
    "--allowedTools", task.allowedTools,
    // A shell env var LOSES to the user's settings.json env block, and Claude Code
    // has no [1m] model alias — --settings is highest-precedence in the CLI's
    // settings chain, so it's the only route that overrides that block per-leaf.
    ...(settings ? ["--settings", JSON.stringify(settings)] : []),
    // interrogation path: continue an existing leaf session (`swarm ask`)
    ...(task.resume ? ["--resume", task.resume] : []),
    "--output-format", "stream-json", "--verbose",
  ];

  if (isClaudeModel(task.model)) {
    return { argv: [claudePath, ...claudeArgs], env: {} };
  }

  if (cfg.provider?.mode === "launch") {
    // Template like "ollama launch claude --model {model} -- {args}":
    // {model} substitutes in place; the {args} token splices the claude args.
    const argv = [];
    for (const token of String(cfg.provider.launchCmd).split(/\s+/).filter(Boolean)) {
      if (token === "{args}") argv.push(...claudeArgs);
      else argv.push(token.replaceAll("{model}", task.model));
    }
    return { argv, env: {} };
  }

  // env mode: model name passes through verbatim (`minimax-m3:cloud`-style).
  return {
    argv: [claudePath, ...claudeArgs],
    env: {
      ANTHROPIC_BASE_URL: cfg.provider.url,
      ANTHROPIC_API_KEY: cfg.provider.authToken,
      ANTHROPIC_MODEL: task.model,
    },
  };
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
