// Forked from plugins/claude-peers/src/broker/index.mjs (port 7898, distinct from
// claude-peers' 7899). Keeps ad-hoc-sender auto-registration, self-heal, and
// corrupt-file quarantine; drops /set-summary. Delivery matches the parent:
// pushed messages are retained 24h; /take-messages is what removes.
import http from "node:http";
import fs from "node:fs";
import { emptyState, loadState, saveState } from "./broker-store.mjs";

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// Ad-hoc sender ids arrive from outside the register flow — constrain them.
const ADHOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ADHOC_REAP_MS = 60 * 60 * 1000;
// The daemon never /register s — it appears only as a sender (auto-registered
// adhoc) and as a recipient. Ad-hoc peers are reaped after 1 h, so a reserved
// recipient must not depend on prior traffic: it is materialised on receive
// and never reaped, or every reply on a cold or restarted broker fails.
const RESERVED_PEER_IDS = new Set(["slack-bridge"]);
// A pushed message is kept so check_messages can still find it: the push is a
// notification with no ack, and a session that never renders it (no --channels
// allowlist on launch, or a provider whose sessions cannot render at all) must
// not lose the message outright. Backstop only — reaping the peer drops its
// messages first in the normal case.
const RETAIN_DELIVERED_MS = 24 * 60 * 60 * 1000;

const MAX_BODY_BYTES = 1_000_000;

export function createBroker({
  stateFile = null,
  log = () => {},
  token = null,
  onShutdown = null,
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
  let nextMsgId = state.messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;

  const persist = () => { if (stateFile) saveState(stateFile, state); };

  function generateId() {
    let id;
    do {
      id = Array.from({ length: 8 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");
    } while (state.peers[id]);
    return id;
  }

  function isAlive(peer) {
    if (peer.kind === "reserved") return true; // materialised on receive, immune to reap
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
    state.messages = state.messages.filter((m) => m.to_id !== id);
  }

  function purgeExpired() {
    const cutoff = _now().getTime() - RETAIN_DELIVERED_MS;
    state.messages = state.messages.filter((m) => !m.delivered || new Date(m.sent_at).getTime() >= cutoff);
  }

  function reapDead() {
    for (const peer of Object.values(state.peers)) {
      if (!isAlive(peer)) reap(peer.id);
    }
    purgeExpired();
  }

  const handlers = {
    "/register"(body) {
      for (const peer of Object.values(state.peers)) {
        // reap, not delete: the replaced id's undelivered queue must go with it
        if (peer.pid > 0 && peer.pid === body.pid) reap(peer.id);
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
      // hasOwn, not a bare index: state.peers is a parsed object, so `peers["constructor"]`
      // is truthy — that would skip the reserved check and queue to an id nothing polls.
      if (!Object.hasOwn(state.peers, body.to_id)) {
        if (!RESERVED_PEER_IDS.has(body.to_id)) {
          return { ok: false, error: `Peer ${body.to_id} not found` };
        }
        const now = _now().toISOString();
        state.peers[body.to_id] = {
          id: body.to_id, pid: 0, cwd: "", git_root: null, tty: null,
          summary: "(reserved: daemon recipient)", kind: "reserved", registered_at: now, last_seen: now,
        };
      } else if (state.peers[body.to_id].kind === "adhoc" && RESERVED_PEER_IDS.has(body.to_id)) {
        state.peers[body.to_id].kind = "reserved"; // state file written pre-reserved: upgrade in place
      }
      const from = String(body.from_id ?? "");
      const now = _now().toISOString();
      if (!Object.hasOwn(state.peers, from)) {
        // Unregistered sender: auto-register so replies have a route back. The
        // daemon relies on this — it sends as "slack-bridge" with no /register,
        // so a reserved id registers as reserved (never reaped), not adhoc.
        if (!ADHOC_ID_RE.test(from)) return { ok: false, error: `Invalid sender id ${from}` };
        state.peers[from] = {
          id: from, pid: 0, cwd: "", git_root: null, tty: null,
          summary: RESERVED_PEER_IDS.has(from) ? "(slack-bridge daemon)" : "(ad-hoc sender)",
          kind: RESERVED_PEER_IDS.has(from) ? "reserved" : "adhoc", registered_at: now, last_seen: now,
        };
      } else if (state.peers[from].kind === "adhoc") {
        if (RESERVED_PEER_IDS.has(from)) state.peers[from].kind = "reserved";
        state.peers[from].last_seen = now;
      }
      state.messages.push({
        id: nextMsgId++, from_id: from, to_id: body.to_id,
        text: String(body.text), sent_at: now, delivered: false,
      });
      persist();
      return { ok: true };
    },

    // Push path. Returns what has not been pushed yet and marks it pushed, but
    // keeps it: a channel notification fires into a session that may never
    // render it, and nothing acks back, so deleting here loses the message
    // outright. /take-messages is what actually removes.
    "/poll-messages"(body) {
      // Optional from_id scopes the poll to one sender, so concurrent claimed
      // channels never mark each other's replies delivered.
      const mine = state.messages.filter((m) => m.to_id === body.id && !m.delivered
        && (!body.from_id || m.from_id === body.from_id));
      for (const msg of mine) msg.delivered = true;
      const peer = Object.hasOwn(state.peers, body.id) ? state.peers[body.id] : null;
      if (peer?.kind === "adhoc") peer.last_seen = _now().toISOString();
      purgeExpired();
      persist();
      return { messages: mine };
    },

    // Consume path, driven by the check_messages tool. Returns everything held
    // for the peer — pushed or not — and removes it. A message already rendered
    // comes back one extra time; that beats the alternative of never seeing it.
    "/take-messages"(body) {
      const mine = state.messages.filter((m) => m.to_id === body.id);
      state.messages = state.messages.filter((m) => m.to_id !== body.id);
      const peer = Object.hasOwn(state.peers, body.id) ? state.peers[body.id] : null;
      if (peer?.kind === "adhoc") peer.last_seen = _now().toISOString();
      persist();
      return { messages: mine };
    },

    "/unregister"(body) {
      if (RESERVED_PEER_IDS.has(body.id)) return { ok: false, error: `Peer ${body.id} is reserved` };
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
      return res.end("slack-bridge remote-control broker");
    }
    // Token guard, mirroring the control endpoint: with remote.controlToken
    // set, every state-touching route requires it. /health stays open —
    // liveness probes must start or adopt the broker without the secret.
    if (token) {
      const auth = req.headers.authorization ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (provided !== token) return json(401, { error: "unauthorized" });
    }
    if (req.url === "/shutdown") {
      json(200, { ok: true });
      // let the response flush, then close; pid-kill-free stop path
      setTimeout(() => server.close(() => onShutdown?.()), 50);
      return;
    }
    let buf = "";
    let overflow = false;
    req.on("data", (c) => {
      if (overflow) return;
      buf += c;
      if (buf.length > MAX_BODY_BYTES) {
        overflow = true;
        json(413, { error: "body too large" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
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
