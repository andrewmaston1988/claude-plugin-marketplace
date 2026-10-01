import { dirname } from "node:path";
import { runResult } from "./contracts.mjs";
import { createCodexStreamParser } from "./stream.mjs";
import { providerConfig, readNow } from "./providers.mjs";
import { normalizeForCompare } from "./roots.mjs";
import { holdNote, staleAgeMark } from "./usage.mjs";
import { discoverCodexModels } from "./codex-app-server.mjs";

export { normalizeCodexModel, createCodexAppServerClient, discoverCodexModels } from "./codex-app-server.mjs";

function writeEffortArg(args, effort) {
  if (typeof effort !== "string" || !effort.trim()) return;
  args.push("-c", `model_reasoning_effort=${JSON.stringify(effort.trim())}`);
}

/** The sandbox a codex task runs under. Exported so the engine's prompt notice
 *  names the same word the dispatch will actually pass. */
export function codexSandbox(task, context) {
  const cfg = providerConfig(context?.config || context?.cfg || {}, "codex");
  const writeCapable = task.write === true || task.writeCapable === true || task.worktreeName ||
    /(?:^|,)(?:Write|Edit|Bash)(?:,|$)/.test(String(task.allowedTools || ""));
  const sandbox = task.sandbox || (writeCapable ? (cfg.sandbox || "workspace-write") : "read-only");
  if (!["read-only", "workspace-write"].includes(sandbox)) {
    throw new Error(`Codex sandbox must be read-only or workspace-write, got '${sandbox}'`);
  }
  return sandbox;
}

function writeSandboxArg(args, task, context) {
  args.push("--sandbox", codexSandbox(task, context));
}

// The engine's typed write targets, as directories. `--add-dir` grants a whole
// directory and has no file-level equivalent, so a `file` target contributes its
// containing directory — deliberately broader than the Claude guard's exact-file
// root, which is the narrower primitive this runner does not have.
function writeTargetDirs(task) {
  const targets = Array.isArray(task.writeRoots) ? task.writeRoots : [];
  return targets
    .map((target) => {
      const path = typeof target?.path === "string" ? target.path.trim() : "";
      if (!path) return null;
      return target.kind === "file" ? dirname(path) : path;
    })
    .filter(Boolean);
}

// The same typed targets as exact paths, for the PreToolUse guard the plugin's
// hooks.json runs on an `apply_patch`. Codex has no `--settings`, so the roots ride
// the spawn env and the guard command stays fixed — Codex keys hook trust by a hash
// of the command, so a per-leaf command would never be trusted and never run.
function writeGuardRootsEnv(task) {
  const paths = (Array.isArray(task.writeRoots) ? task.writeRoots : [])
    .map((target) => (typeof target?.path === "string" ? target.path.trim() : ""))
    .filter(Boolean);
  return paths.length ? JSON.stringify(paths) : "";
}

/** Build native `codex exec --json` argv. */
export function buildCodexInvocation(task, prompt, context = {}) {
  const cfg = providerConfig(context.config || context.cfg || {}, "codex");
  const executable = context.executable || cfg.path || "codex";
  const sessionId = task.resume || task.sessionId;
  const args = ["exec", "--json"];
  if (task.model) args.push("--model", task.model);
  writeEffortArg(args, task.effort ?? task.reasoningEffort ?? "medium");
  writeSandboxArg(args, task, context);
  // The scheduler writes this file — codex takes only strict form, and the builder stays pure.
  if (task.returns && context.schemaPath) args.push("--output-schema", context.schemaPath);
  const addDirs = task.additionalDirs || context.additionalDirs || cfg.additionalDirs || [];
  // Existing entries are emitted first, verbatim — the write targets only append.
  // Everything already writable (the primary cwd, or an entry emitted above) is
  // skipped, so an ordinary leaf's argv is unchanged and a target cannot produce
  // a duplicate --add-dir through separator style or win32 casing.
  const writable = new Set();
  if (task.cwd) writable.add(normalizeForCompare(task.cwd));
  for (const dir of Array.isArray(addDirs) ? addDirs : [addDirs]) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    args.push("--add-dir", dir);
    writable.add(normalizeForCompare(dir));
  }
  for (const dir of writeTargetDirs(task)) {
    const key = normalizeForCompare(dir);
    if (writable.has(key)) continue;
    writable.add(key);
    args.push("--add-dir", dir);
  }
  // The generated digest launches from engine scratch — a cwd outside every Git
  // repository, where `codex exec` refuses to start. Scoped to the digest by the
  // cwd/originalCwd comparison (a pure comparison, not a filesystem probe): an
  // ordinary Codex leaf keeps the repo-root gate that stops it wandering.
  if (task.isDigest === true && task.cwd !== task.originalCwd) args.push("--skip-git-repo-check");
  if (sessionId) args.push("resume", sessionId);
  args.push(prompt);
  // settings.env is the one settings key with a Codex route: the spawn env. The guard
  // roots are spread LAST so a task cannot forge or clear the list that confines it.
  return {
    argv: [executable, ...args],
    env: {
      ...(cfg.env || {}),
      ...(task.settings?.env || {}),
      SWARM_WRITE_GUARD_ROOTS: writeGuardRootsEnv(task),
    },
  };
}

export function classifyCodexExit(exit = {}, parsed = {}, task = {}) {
  const code = exit?.code ?? exit?.status ?? exit;
  const clean = code === 0 && parsed?.terminal === true && !parsed?.error;
  const error = parsed?.error || (clean ? undefined : {
    code: code == null ? "spawn" : `exit-${code}`,
    message: code === 0 ? "Codex runner ended without terminal completion" : `Codex runner exited with code ${code}`,
  });
  return runResult({
    provider: parsed?.provider || "codex",
    model: task.model || parsed.model || "codex",
    output: String(parsed?.output ?? parsed?.text ?? ""),
    terminal: clean,
    ...(parsed?.sessionId && { sessionId: parsed.sessionId }),
    ...(parsed?.usage && { usage: parsed.usage }),
    ...(parsed?.realModel && { realModel: parsed.realModel }),
    ...(error && { error }),
  });
}

/** Concrete Codex runner adapter for the runner contract. */
export function createCodexRunnerAdapter(options = {}) {
  const cancelled = new WeakSet();
  return {
    id: "codex",
    buildInvocation: (task, prompt, context = {}) => buildCodexInvocation(task, prompt, {
      ...context,
      ...(options.executable && { executable: options.executable }),
    }),
    createParser: (emit, context = {}) => createCodexStreamParser({ emit, ...context }),
    classifyExit: (exit, parsed, task = {}) => classifyCodexExit(exit, parsed, task),
    cancel(child) {
      if (!child || cancelled.has(child)) return;
      cancelled.add(child);
      try { child.kill?.(); } catch { /* already gone */ }
    },
  };
}

export const defaultCodexRunnerAdapter = createCodexRunnerAdapter();

/** Concrete Codex provider adapter; its capabilities remain opt-in to callers. */
export function createCodexProviderAdapter(options = {}) {
  // Spawning the app-server just to read usage is opt-in unless a client is already live.
  const readUsage = async (context = {}) => {
    if (!context.client && context.usageOptIn !== true) return null;
    const { readCodexUsageThroughCache } = await import("./codex-usage.mjs");
    return readCodexUsageThroughCache(options, context);
  };
  return {
    id: "codex",
    runnerId: "codex",
    enabled: (config) => providerConfig(config, "codex").enabled === true,
    validateTask(task, context = {}) {
      const problems = [];
      if (typeof task?.model !== "string" || !task.model.trim()) problems.push("Codex tasks require a non-empty model");
      if (task?.sandbox === "danger-full-access") problems.push("Codex tasks cannot use danger-full-access");
      // Codex has no `--settings`: `env` is reachable (the spawn env), and every other
      // key is Claude-only. Named individually — the blanket refusal left an author with
      // no way to tell which key was the problem, or that `env` was fine all along.
      const settings = task?.settings;
      if (settings !== undefined) {
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          problems.push('Codex settings must be a JSON object — e.g. "settings": {"env": {"X": "1"}}');
        } else {
          const refused = Object.keys(settings).filter((key) => key !== "env");
          if (refused.length) {
            problems.push(`Codex tasks accept only settings.env — remove ${refused.map((k) => `'${k}'`).join(", ")}`);
          }
          // It is spread straight into the spawn env, so a string would arrive as
          // keys "0", "1", … and the intended vars would silently stay unset.
          const env = settings.env;
          if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) {
            problems.push('Codex settings.env must be a JSON object — e.g. "settings": {"env": {"X": "1"}}');
          }
        }
      }
      if (context.config && !providerConfig(context.config, "codex").enabled) problems.push("Codex provider is disabled");
      return problems;
    },
    capabilities: {
      discoverModels: (context = {}) => discoverCodexModels(context.config || {}, {
        ...options,
        ...context,
      }),
      readUsage,
      // Codex counterpart to Claude preflight; preserve its fallback exemption.
      preflight: async (context = {}) => {
        if (context.config?.quotaPreflight === false) return { ok: true };
        const usage = await readUsage({ ...context, usageOptIn: true });
        const blocked = (context.tasks || []).filter((task) => !task.fallbackModel);
        if (usage?.exhausted && blocked.length) {
          if (usage.provenance === "stale") {
            const nowMs = readNow(context.now);
            const held = [staleAgeMark(usage, nowMs), holdNote(usage, { now: nowMs })].filter(Boolean).join(" · ");
            context.io?.stdout?.(`⚠ Codex usage reads exhausted on a stale reading${held ? ` — ${held}` : ""} — dispatching anyway`);
            return { ok: true, usage };
          }
          return { ok: false, error: `Codex usage is exhausted — ${blocked.map((task) => task.id).join(", ")} cannot dispatch. Add fallbackModel or re-run after reset.` };
        }
        // Like Claude's: only exhaustion blocks; an unreadable meter dispatches.
        return { ok: true, usage };
      },
    },
  };
}

export const defaultCodexProviderAdapter = createCodexProviderAdapter();
