// HTTP client for the internal broker, used by the daemon (startBridge) and the
// routing branch (handler.mjs). Self-heals: if the broker is down, spawns it
// detached and retries — mirrors the claude-peers MCP server's ensureBroker.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A thrown fetch means the broker is unreachable; a broker error response is an
// ordinary Error from our own !ok branch and must NOT trigger a respawn.
const isConnectionError = (e) =>
  e instanceof TypeError || /ECONNREFUSED|ECONNRESET|fetch failed|aborted|timeout/i.test(e?.message ?? "");

export function createBrokerClient({
  port,
  token = null,
  binPath = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url)),
  log = () => {},
  _fetch = fetch,
  _spawn = spawn,
  _execPath = process.execPath,
  _setInterval = setInterval,
} = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  // /health stays unauthenticated on purpose: it's the liveness probe that
  // decides whether to spawn the broker, and the token comes from the same
  // config the broker itself was started with.
  const authHeaders = token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" };

  async function health() {
    try {
      const res = await _fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  function spawnBroker() {
    // detached + ignored stdio: the broker must outlive the bridge process tree.
    const child = _spawn(_execPath, [binPath, "broker", "run", "--port", String(port)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  // single-flight: concurrent failures share one respawn
  let ensuring = null;
  function ensureBroker() {
    ensuring ??= doEnsureBroker().finally(() => { ensuring = null; });
    return ensuring;
  }

  async function doEnsureBroker() {
    if (await health()) return;
    log("broker not reachable — starting daemon");
    spawnBroker();
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      if (await health()) return;
    }
    throw new Error(`failed to start broker daemon on port ${port} after 6s`);
  }

  async function brokerFetch(path, body, { retried = false } = {}) {
    try {
      const res = await _fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (retried || !isConnectionError(e)) throw e;
      await ensureBroker();
      return brokerFetch(path, body, { retried: true });
    }
  }

  return {
    port,
    ensureBroker,
    health,
    isAlive: async (peerId) => {
      const peers = await brokerFetch("/list-peers", { scope: "machine", cwd: "", git_root: null, include_adhoc: true });
      return peers.some((p) => p.id === peerId);
    },
    listPeers: (opts = {}) => brokerFetch("/list-peers", { scope: "machine", cwd: "", git_root: null, include_adhoc: true, ...opts }),
    sendMessage: (fromId, toId, text) => brokerFetch("/send-message", { from_id: fromId, to_id: toId, text }),
    pollMessages: (id, fromId) => brokerFetch("/poll-messages", fromId ? { id, from_id: fromId } : { id }).then((r) => r.messages ?? []),
    register: (body) => brokerFetch("/register", body),
    heartbeat: (id) => brokerFetch("/heartbeat", { id }),
    unregister: (id) => brokerFetch("/unregister", { id }),
    shutdown: () => _fetch(`${baseUrl}/shutdown`, { method: "POST", headers: authHeaders, signal: AbortSignal.timeout(2000) }).catch(() => {}),
  };
}
