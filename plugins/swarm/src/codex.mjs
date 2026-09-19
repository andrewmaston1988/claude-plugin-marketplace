import { spawn as nodeSpawn } from "node:child_process";
import { modelDescriptor, runResult } from "./contracts.mjs";
import { createCodexStreamParser } from "./stream.mjs";
import { providerConfig } from "./providers.mjs";

const DEFAULT_CLIENT_INFO = {
  name: "swarm",
  title: "swarm",
  version: "0.1.0",
};

function asError(value, fallback = "Codex app-server request failed") {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  const message = value?.message || fallback;
  const error = new Error(String(message));
  if (value?.code !== undefined) error.code = value.code;
  if (value?.data !== undefined) error.data = value.data;
  return error;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function modelEfforts(row) {
  const values = row?.supportedReasoningEfforts ?? row?.reasoningEfforts ?? row?.efforts;
  if (!Array.isArray(values)) return undefined;
  const efforts = values
    .map((value) => typeof value === "string" ? value : value?.reasoningEffort ?? value?.effort ?? value?.id)
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  return [...new Set(efforts)];
}

function modelModalities(row) {
  const values = row?.inputModalities ?? row?.modalities;
  if (!Array.isArray(values)) return undefined;
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

/** Normalize one app-server model/list row into the Stage 1 model contract. */
export function normalizeCodexModel(row) {
  const model = row?.id ?? row?.model ?? row?.modelId;
  if (typeof model !== "string" || !model.trim()) return null;
  const efforts = modelEfforts(row);
  const modalities = modelModalities(row);
  return modelDescriptor({
    provider: "codex",
    model: model.trim(),
    runner: "codex",
    ...(typeof (row?.displayName ?? row?.display_name) === "string" && {
      displayName: row.displayName ?? row.display_name,
    }),
    ...(efforts?.length ? { efforts } : {}),
    ...(modalities?.length ? { modalities } : {}),
    ...(typeof row?.isDefault === "boolean" ? { isDefault: row.isDefault } : {}),
    ...(row?.availability && typeof row.availability === "object" && !Array.isArray(row.availability)
      ? { availability: row.availability }
      : {}),
  });
}

/** Start an injected Codex app-server JSONL client.
 * Own process lifetime, correlation, initialization, timeouts, diagnostics, and cleanup.
 */
export function createCodexAppServerClient({
  executable = "codex",
  args = ["app-server", "--stdio"],
  env,
  timeoutMs = 10_000,
  spawnImpl = nodeSpawn,
  _spawn,
  clientInfo = DEFAULT_CLIENT_INFO,
  capabilities = {},
} = {}) {
  const spawn = _spawn || spawnImpl;
  let child = null;
  let closed = false;
  let closeError = null;
  let initialized = false;
  let nextId = 1;
  let stdoutBuffer = "";
  let stdoutNoise = "";
  let stderr = "";
  let killed = false;
  const pending = new Map();
  const subscribers = new Set();

  function killChild() {
    if (killed || !child) return;
    killed = true;
    try { child.kill?.(); } catch { /* already gone */ }
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function closeWith(error = null) {
    if (closed) return;
    closed = true;
    closeError = error ? asError(error) : null;
    rejectPending(closeError || new Error("Codex app-server client closed"));
    killChild();
  }

  function dispatch(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      stdoutNoise += `${String(message)}\n`;
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = asError(message.error, `Codex app-server error for request ${entry.method}`);
        error.rpc = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const subscriber of subscribers) {
        try { subscriber(message); } catch { /* notification listeners are isolated */ }
      }
      return;
    }
    stdoutNoise += `${JSON.stringify(message)}\n`;
  }

  function handleStdout(chunk) {
    stdoutBuffer += String(chunk);
    let index;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        // App-server speaks JSONL. Non-JSON stdout is retained as diagnostic
        // noise but can never satisfy a pending request.
        stdoutNoise += line + "\n";
      }
    }
  }

  function handleStderr(chunk) {
    stderr += String(chunk);
  }

  function start() {
    if (closed) throw closeError || new Error("Codex app-server client is closed");
    if (child) return child;
    try {
      child = spawn(executable, args, {
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      closeWith(error);
      throw error;
    }
    child.stdout?.on?.("data", handleStdout);
    child.stderr?.on?.("data", handleStderr);
    child.on?.("error", (error) => closeWith(error));
    child.on?.("close", (code, signal) => {
      if (closed) return;
      const details = [
        `Codex app-server exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
        stderr.trim(),
        stdoutNoise.trim(),
      ].filter(Boolean).join("\n");
      closeWith(new Error(details || "Codex app-server exited before answering"));
    });
    return child;
  }

  function request(method, params = {}, { requestTimeoutMs = timeoutMs } = {}) {
    if (closed) return Promise.reject(closeError || new Error("Codex app-server client is closed"));
    try { start(); } catch (error) { return Promise.reject(error); }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Codex app-server request timed out: ${method}`);
        error.code = "ETIMEDOUT";
        closeWith(error);
      }, requestTimeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        child.stdin.write(jsonLine({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
        closeWith(error);
      }
    });
  }

  function notify(method, params = {}) {
    if (closed) throw closeError || new Error("Codex app-server client is closed");
    start();
    child.stdin.write(jsonLine({ method, params }));
  }

  async function initialize(options = {}) {
    if (initialized) return undefined;
    const result = await request("initialize", {
      clientInfo: options.clientInfo || clientInfo,
      capabilities: options.capabilities || capabilities,
    }, options);
    notify("initialized", {});
    initialized = true;
    return result;
  }

  async function call(method, params = {}, options = {}) {
    await initialize(options);
    return request(method, params, options);
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new Error("Codex app-server notification listener must be a function");
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  return {
    start,
    request,
    call,
    initialize,
    notify,
    subscribe,
    close: () => closeWith(),
    get child() { return child; },
    get initialized() { return initialized; },
    get diagnostics() { return { stderr, stdoutNoise, pending: pending.size, closed, killed }; },
  };
}

function responseResult(response) {
  return response?.result && typeof response.result === "object" ? response.result : response || {};
}

function pageRows(result) {
  const rows = result?.data ?? result?.models ?? result?.items ?? [];
  return Array.isArray(rows) ? rows : [];
}

function nextCursor(result) {
  return result?.nextCursor ?? result?.next_cursor ?? result?.next ?? null;
}

async function makeClient(config, options) {
  if (options.client) return { client: options.client, owned: false };
  const cfg = providerConfig(config, "codex");
  const factory = options.clientFactory || options._clientFactory;
  if (factory) {
    const client = await factory({ config, provider: cfg, ...options });
    return { client, owned: options.ownedClient !== false };
  }
  return {
    client: createCodexAppServerClient({
      executable: options.executable || cfg.path || "codex",
      args: options.args || ["app-server", "--stdio"],
      timeoutMs: options.timeoutMs ?? cfg.timeoutMs ?? 10_000,
      spawnImpl: options.spawnImpl || options._spawn,
      env: options.env,
    }),
    owned: true,
  };
}

/** Discover the account-visible Codex roster through app-server model/list. */
export async function discoverCodexModels(config = {}, options = {}) {
  const { client, owned } = await makeClient(config, options);
  if (!client) throw new Error("Codex app-server client factory returned no client");
  const out = [];
  const seenModels = new Set();
  const seenCursors = new Set();
  try {
    if (typeof client.initialize === "function") await client.initialize(options);
    let cursor = null;
    for (;;) {
      const params = { cursor, ...(options.limit ? { limit: options.limit } : {}) };
      const response = typeof client.request === "function"
        ? await client.request("model/list", params)
        : await client.call("model/list", params, options);
      const result = responseResult(response);
      for (const row of pageRows(result)) {
        const descriptor = normalizeCodexModel(row);
        if (descriptor && !seenModels.has(descriptor.model)) {
          seenModels.add(descriptor.model);
          out.push(descriptor);
        }
      }
      const next = nextCursor(result);
      if (next == null || next === "" || seenCursors.has(String(next))) break;
      seenCursors.add(String(next));
      cursor = next;
    }
    return out;
  } finally {
    if (owned && typeof client.close === "function") await client.close();
  }
}

function writeEffortArg(args, effort) {
  if (typeof effort !== "string" || !effort.trim()) return;
  args.push("-c", `model_reasoning_effort=${JSON.stringify(effort.trim())}`);
}

function writeSandboxArg(args, task, context) {
  const cfg = providerConfig(context?.config || context?.cfg || {}, "codex");
  const writeCapable = task.write === true || task.writeCapable === true || task.isolation ||
    /(?:^|,)(?:Write|Edit|Bash)(?:,|$)/.test(String(task.allowedTools || ""));
  const sandbox = task.sandbox || (writeCapable ? (cfg.sandbox || "workspace-write") : "read-only");
  if (!["read-only", "workspace-write"].includes(sandbox)) {
    throw new Error(`Codex sandbox must be read-only or workspace-write, got '${sandbox}'`);
  }
  args.push("--sandbox", sandbox);
}

/** Build native `codex exec --json` argv; dispatch activation remains Stage 3. */
export function buildCodexInvocation(task, prompt, context = {}) {
  const cfg = providerConfig(context.config || context.cfg || {}, "codex");
  const executable = context.executable || cfg.path || "codex";
  const sessionId = task.resume || task.sessionId;
  const args = ["exec", "--json"];
  if (task.model) args.push("--model", task.model);
  writeEffortArg(args, task.effort || task.reasoningEffort);
  writeSandboxArg(args, task, context);
  const addDirs = task.additionalDirs || context.additionalDirs || cfg.additionalDirs || [];
  for (const dir of Array.isArray(addDirs) ? addDirs : [addDirs]) {
    if (typeof dir === "string" && dir.trim()) args.push("--add-dir", dir);
  }
  if (sessionId) args.push("resume", sessionId);
  args.push(prompt);
  return { argv: [executable, ...args], env: { ...(cfg.env || {}) } };
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

/** Concrete Codex runner adapter for Stage 1's runner contract. */
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
  return {
    id: "codex",
    runnerId: "codex",
    enabled: (config) => providerConfig(config, "codex").enabled === true,
    matchModel: (model, cache = []) => cache.some((row) => row?.provider === "codex" && row?.model === model)
      ? { provider: "codex", model }
      : null,
    validateTask(task, context = {}) {
      const problems = [];
      if (typeof task?.model !== "string" || !task.model.trim()) problems.push("Codex tasks require a non-empty model");
      if (task?.sandbox === "danger-full-access") problems.push("Codex tasks cannot use danger-full-access");
      if (task?.settings !== undefined) problems.push("Codex tasks do not accept Claude-only settings");
      if (context.config && !providerConfig(context.config, "codex").enabled) problems.push("Codex provider is disabled");
      return problems;
    },
    capabilities: {
      discoverModels: (context = {}) => discoverCodexModels(context.config || {}, {
        ...options,
        ...context,
      }),
      readUsage: async (context = {}) => {
        const { readCodexUsage } = await import("./codex-usage.mjs");
        return readCodexUsage(context.config || {}, { ...options, ...context });
      },
    },
  };
}

export const defaultCodexProviderAdapter = createCodexProviderAdapter();
