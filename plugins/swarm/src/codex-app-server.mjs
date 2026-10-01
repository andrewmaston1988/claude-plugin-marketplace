import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { modelDescriptor } from "./contracts.mjs";
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

// The row names its default effort outright, where Claude's carries it as a badge
// on one of the options. Both reach `effortFor` under the same field name.
function modelDefaultEffort(row) {
  const value = row?.defaultReasoningEffort ?? row?.default_reasoning_effort;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function modelModalities(row) {
  const values = row?.inputModalities ?? row?.modalities;
  if (!Array.isArray(values)) return undefined;
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

/** Normalize one app-server model/list row into the canonical model descriptor. */
export function normalizeCodexModel(row) {
  const model = row?.id ?? row?.model ?? row?.modelId;
  if (typeof model !== "string" || !model.trim()) return null;
  const efforts = modelEfforts(row);
  const defaultEffort = modelDefaultEffort(row);
  const modalities = modelModalities(row);
  return modelDescriptor({
    provider: "codex",
    model: model.trim(),
    runner: "codex",
    ...(typeof (row?.displayName ?? row?.display_name) === "string" && {
      displayName: row.displayName ?? row.display_name,
    }),
    ...(efforts?.length ? { efforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
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

  // One decoder per stream: a chunk boundary can split a multibyte character, and
  // decoding each chunk on its own turns the halves into U+FFFD. A chunk that is
  // already a string was decoded upstream and needs no help.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const decode = (decoder, chunk) => (typeof chunk === "string" ? chunk : decoder.write(chunk));

  function handleStdout(chunk) {
    stdoutBuffer += decode(stdoutDecoder, chunk);
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
    stderr += decode(stderrDecoder, chunk);
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
      // Same config key the usage reader spawns with: discovery and usage must
      // reach the same app-server, or a non-default one works for one and not the other.
      args: options.args || cfg.appServerArgs,
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
