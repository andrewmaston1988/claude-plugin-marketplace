import http from "node:http";
import fs from "node:fs";
import { emptyState, loadState, saveState } from "./store.mjs";

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// Ad-hoc sender ids arrive from outside the register flow — constrain them.
const ADHOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ADHOC_REAP_MS = 60 * 60 * 1000;

export function createBroker({
  stateFile = null,
  log = () => {},
  _kill = (pid) => process.kill(pid, 0),
  _now = () => new Date(),
} = {}) {
  let state;
  try {
    state = stateFile ? loadState(stateFile) : emptyState();
  } catch (e) {
    // Quarantine, never overwrite silently: the corrupt file stays on disk for inspection.
    const quarantine = `${stateFile}.corrupt-${Date.now()}`;
    try { fs.renameSync(stateFile, quarantine); } catch {}
    log(`state file corrupt (${e.message}) — quarantined to ${quarantine}, starting empty`);
    state = emptyState();
  }
  let nextMsgId = state.messages.reduce((m, x) => Math.max(m, x.id), 0) + 1;

  const persist = () => { if (stateFile) saveState(stateFile, state); };

  function generateId() {
    let id;
    do {
      id = Array.from({ length: 8 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");
    } while (state.peers[id]);
    return id;
  }

  function isAlive(peer) {
    if (peer.kind === "adhoc") return _now() - new Date(peer.last_seen) < ADHOC_REAP_MS;
    try {
      _kill(peer.pid);
      return true;
    } catch {
      return false;
    }
  }

  function reap(id) {
    delete state.peers[id];
    state.messages = state.messages.filter((m) => !(m.to_id === id && !m.delivered));
  }

  function reapDead() {
    for (const peer of Object.values(state.peers)) {
      if (!isAlive(peer)) reap(peer.id);
    }
  }

  const handlers = {
    "/register"(body) {
      for (const peer of Object.values(state.peers)) {
        if (peer.pid > 0 && peer.pid === body.pid) delete state.peers[peer.id];
      }
      const id = generateId();
      const now = _now().toISOString();
      state.peers[id] = {
        id,
        pid: body.pid,
        cwd: body.cwd ?? "",
        git_root: body.git_root ?? null,
        tty: body.tty ?? null,
        summary: body.summary ?? "",
        kind: "session",
        registered_at: now,
        last_seen: now,
      };
      persist();
      return { id };
    },

    "/heartbeat"(body) {
      const peer = state.peers[body.id];
      if (peer) {
        peer.last_seen = _now().toISOString();
        persist();
      }
      return { ok: true };
    },

    "/set-summary"(body) {
      const peer = state.peers[body.id];
      if (peer) {
        peer.summary = String(body.summary ?? "");
        persist();
      }
      return { ok: true };
    },

    "/list-peers"(body) {
      reapDead();
      let peers = Object.values(state.peers);
      if (!body.include_adhoc) peers = peers.filter((p) => p.kind !== "adhoc");
      if (body.scope === "directory") {
        peers = peers.filter((p) => p.cwd === body.cwd);
      } else if (body.scope === "repo") {
        peers = body.git_root
          ? peers.filter((p) => p.git_root === body.git_root)
          : peers.filter((p) => p.cwd === body.cwd);
      }
      if (body.exclude_id) peers = peers.filter((p) => p.id !== body.exclude_id);
      persist();
      return peers;
    },

    "/send-message"(body) {
      if (!state.peers[body.to_id]) {
        return { ok: false, error: `Peer ${body.to_id} not found` };
      }
      const from = String(body.from_id ?? "");
      const now = _now().toISOString();
      if (!state.peers[from]) {
        // Unregistered sender: auto-register as adhoc so replies have a route back.
        if (!ADHOC_ID_RE.test(from)) return { ok: false, error: `Invalid sender id ${from}` };
        state.peers[from] = {
          id: from, pid: 0, cwd: "", git_root: null, tty: null,
          summary: "(ad-hoc sender)", kind: "adhoc", registered_at: now, last_seen: now,
        };
      } else if (state.peers[from].kind === "adhoc") {
        state.peers[from].last_seen = now;
      }
      state.messages.push({
        id: nextMsgId++, from_id: from, to_id: body.to_id,
        text: String(body.text), sent_at: now, delivered: false,
      });
      persist();
      return { ok: true };
    },

    "/poll-messages"(body) {
      const mine = state.messages.filter((m) => m.to_id === body.id && !m.delivered);
      for (const msg of mine) msg.delivered = true;
      state.messages = state.messages.filter((m) => !m.delivered);
      const peer = state.peers[body.id];
      if (peer?.kind === "adhoc") peer.last_seen = _now().toISOString();
      persist();
      return { messages: mine };
    },

    "/unregister"(body) {
      reap(body.id);
      persist();
      return { ok: true };
    },
  };

  const server = http.createServer((req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST") {
      if (req.url === "/health") {
        reapDead();
        persist();
        return json(200, { status: "ok", peers: Object.keys(state.peers).length });
      }
      res.writeHead(200);
      return res.end("claude-peers broker");
    }
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      try {
        const handler = handlers[req.url];
        if (!handler) return json(404, { error: "not found" });
        json(200, handler(buf ? JSON.parse(buf) : {}));
      } catch (e) {
        json(500, { error: e.message });
      }
    });
  });

  return {
    listen: (port) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
    reapDead: () => { reapDead(); persist(); },
  };
}
