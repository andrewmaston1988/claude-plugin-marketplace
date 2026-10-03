// Forked from plugins/claude-peers/src/broker/index.mjs (port 7898, distinct from
// claude-peers' 7899). Keeps ad-hoc-sender auto-registration, self-heal, and
// corrupt-file quarantine; drops /set-summary. Delivery: /wait long-polls and
// /take-messages takes — both consume, so a message reaches exactly one consumer.
// A take with `lease: true` holds the rows until /ack, so a response lost on the
// wire is redelivered when the lease runs out; a take without it consumes outright.
import http from "node:http";
import fs from "node:fs";
import { emptyState, loadState, saveState } from "./broker-store.mjs";
import { WAIT_WINDOW_MS } from "./wait-constants.mjs";

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// Ad-hoc sender ids arrive from outside the register flow — constrain them.
const ADHOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ADHOC_REAP_MS = 60 * 60 * 1000;
// The daemon never /register s — it appears only as a sender (auto-registered
// adhoc) and as a recipient. Ad-hoc peers are reaped after 1 h, so a reserved
// recipient must not depend on prior traffic: it is materialised on receive
// and never reaped, or every reply on a cold or restarted broker fails.
const RESERVED_PEER_IDS = new Set(["slack-bridge"]);
// A message nothing takes (e.g. the doctor probe with no daemon running) is
// dropped after this age. Backstop only — reaping the peer drops its messages
// first in the normal case.
const RETAIN_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 30_000;

const MAX_BODY_BYTES = 1_000_000;
// Armed = a /wait for the peer is open, or one returned within this grace. The
// grace covers the gap between the waiter's windows; without it a Stop hook that
// lands mid-re-arm reads an armed session as unarmed and blocks it.
const WAIT_GRACE_MS = 5_000;
const KINDS = new Set(["status", "question"]);
const normaliseKind = (kind) => (KINDS.has(kind) ? kind : "text");

export function createBroker({
  stateFile = null,
  log = () => {},
  token = null,
  onShutdown = null,
  _kill = (pid) => process.kill(pid, 0),
  _now = () => new Date(),
  _leaseMs = LEASE_MS,
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

  // In memory on purpose: a broker restart drops the open requests, and the
  // waiter's retry re-arms within a window.
  const waiters = new Map();      // peerId -> Set of open waiters
  const armedUntil = new Map();   // peerId -> epoch ms the grace runs to
  // The injected _now returns a Date, so every armed comparison has to go through
  // epoch ms: `now + WAIT_GRACE_MS` on a Date is string concatenation and armed
  // would then never be true.
  const nowMs = () => _now().getTime();
  const isArmed = (id) =>
    (waiters.get(id)?.size ?? 0) > 0 || (armedUntil.get(id) ?? 0) > nowMs();

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
    const cutoff = _now().getTime() - RETAIN_MS;
    state.messages = state.messages.filter((m) => new Date(m.sent_at).getTime() >= cutoff);
  }

  function reapDead() {
    for (const peer of Object.values(state.peers)) {
      if (!isAlive(peer)) reap(peer.id);
    }
    purgeExpired();
  }

  // Take semantics, shared by /wait and /take-messages. `kind` is normalised on
  // the way out so a message written by a pre-upgrade broker still carries one.
  // A row inside its lease is invisible to every take until it expires or is acked.
  const isReady = (m, id) => m.to_id === id && !(m.leased_until > nowMs());

  function takeMessagesFor(id, lease = false) {
    const mine = state.messages.filter((m) => isReady(m, id));
    if (lease && mine.length > 0) {
      for (const m of mine) m.leased_until = nowMs() + _leaseMs;
      setTimeout(() => wakeWaiter(id), _leaseMs).unref();
    } else if (!lease) {
      state.messages = state.messages.filter((m) => !isReady(m, id));
    }
    const peer = Object.hasOwn(state.peers, id) ? state.peers[id] : null;
    if (peer?.kind === "adhoc") peer.last_seen = _now().toISOString();
    persist();
    return mine.map(({ leased_until, delivered, ...m }) => ({ ...m, kind: normaliseKind(m.kind) }));
  }

  // Hand the peer's queue to exactly ONE waiter and leave the others open: two
  // waiters for one peer must never both be given the same message. Nothing
  // ready (a lease timer firing after its ack) leaves the waiter open.
  function wakeWaiter(id) {
    const set = waiters.get(id);
    if (!set || set.size === 0) return;
    if (!state.messages.some((m) => isReady(m, id))) return;
    const waiter = set.values().next().value;
    waiter.finish(takeMessagesFor(id, waiter.lease));
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
        session_id: body.session_id ?? null,
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
      // Copies, not the stored rows: armed is computed and must not be persisted.
      return peers.map((p) => ({ ...p, session_id: p.session_id ?? null, armed: isArmed(p.id) }));
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
        text: String(body.text), kind: normaliseKind(body.kind),
        sent_at: now,
      });
      persist();
      wakeWaiter(body.to_id);
      return { ok: true };
    },

    // Consume path, driven by the check_messages tool. Returns everything held
    // for the peer and removes it.
    "/take-messages"(body) {
      return { messages: takeMessagesFor(body.id, body.lease === true) };
    },

    // Settles a leased take: the acked rows are gone for good.
    "/ack"(body) {
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      state.messages = state.messages.filter((m) => !(m.to_id === body.id && ids.has(m.id)));
      persist();
      return { ok: true };
    },

    // Long-poll, driven by the background waiter. Returns at once when the queue
    // is non-empty; otherwise holds the request until a send for this peer
    // arrives or the window elapses. Take semantics, so the waiter and
    // check_messages are the same consumer and a message never doubles up.
    "/wait"(body, ctx) {
      const id = body.id;
      const lease = body.lease === true;
      const queued = takeMessagesFor(id, lease);
      if (queued.length > 0) return { messages: queued };
      return new Promise((resolve) => {
        let timer;
        const waiter = {
          lease,
          finish(messages) {
            clearTimeout(timer);
            const set = waiters.get(id);
            if (set) { set.delete(waiter); if (set.size === 0) waiters.delete(id); }
            armedUntil.set(id, nowMs() + WAIT_GRACE_MS);
            resolve({ messages });
          },
        };
        timer = setTimeout(() => waiter.finish([]), Number(body.timeout_ms ?? WAIT_WINDOW_MS));
        if (!waiters.has(id)) waiters.set(id, new Set());
        waiters.get(id).add(waiter);
        // The client hung up: drop the waiter without arming, so the peer reads
        // unarmed and the Stop hook can nudge. The messages stay queued.
        ctx?.onDrop?.(() => {
          clearTimeout(timer);
          const set = waiters.get(id);
          if (set) { set.delete(waiter); if (set.size === 0) waiters.delete(id); }
          resolve({ messages: [] });
        });
      });
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
      if (res.writableEnded || res.destroyed) return; // client already gone
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST") {
      if (req.url === "/health") {
        reapDead();
        persist();
        return json(200, { status: "ok", lease: true, peers: Object.keys(state.peers).length });
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
      let handler, body;
      try {
        handler = handlers[req.url];
        if (!handler) return json(404, { error: "not found" });
        body = buf ? JSON.parse(buf) : {};
      } catch (e) {
        return json(500, { error: e.message });
      }
      // /wait holds the response open, so the handler is async and needs a drop
      // hook. `req` "close" fires as soon as the body is consumed — using it
      // would drop every waiter the moment its own request arrived. `res`
      // "close" with writableEnded unset is a real disconnect.
      const drops = [];
      res.on("close", () => {
        if (res.writableEnded) return;
        for (const drop of drops) drop();
      });
      Promise.resolve()
        .then(() => handler(body, { onDrop: (fn) => drops.push(fn) }))
        .then((value) => json(200, value), (e) => json(500, { error: e.message }));
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
