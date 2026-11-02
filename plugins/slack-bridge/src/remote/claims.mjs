// Claim store: maps a Slack channel id → the live-session peer-id that seized it.
// Atomic JSON writes (session-store pattern: tmp + rename). A channel claimed by
// peer A is rejected if peer B tries to claim it; the same peer re-claiming is
// idempotent.
//
// Beside it sits the claim-history file: the session id and channel name of every
// channel ever seized. It outlives the claim, because an `#rc-*` channel must not
// start spawning after release, and a dead session's red block needs its GUID.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function createClaimsStore({ path, log }) {
  let cache = null;
  let historyCache = null;
  const historyPath = path.endsWith(".json")
    ? path.slice(0, -".json".length) + "-history.json"
    : path + "-history.json";

  function readJson(file, what) {
    if (!existsSync(file)) return {};
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (e) {
      log?.warn(`${what} corrupt, starting fresh`, { path: file, error: e.message });
      return {};
    }
  }

  function load() {
    if (cache !== null) return cache;
    cache = readJson(path, "claims store");
    return cache;
  }

  function loadHistory() {
    if (historyCache !== null) return historyCache;
    historyCache = readJson(historyPath, "claim history");
    return historyCache;
  }

  function persist(data) {
    const tmp = path + ".tmp";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
    cache = data;
  }

  // Pure predicate shared by /claim's pre-check (before any Slack channel is
  // created) and claim() itself: channel held by another peer, or this peer
  // already holding a different channel. One claim per peer because replies
  // are drained from_id-scoped — a second claim's replies would surface in
  // the first claim's Slack channel.
  function canClaim(peerId, channel) {
    const data = load();
    // hasOwn, not a bare index: a parsed object inherits constructor/toString/
    // valueOf, and `data["constructor"]` is truthy — a false "already claimed".
    const existing = Object.hasOwn(data, channel) ? data[channel] : null;
    if (existing && existing.peer_id !== peerId) {
      return { ok: false, error: `channel ${channel} already claimed by ${existing.peer_id}` };
    }
    const held = Object.entries(data).find(([ch, c]) => c.peer_id === peerId && ch !== channel);
    if (held) {
      const label = held[1].channel_name ? `#${held[1].channel_name}` : held[0];
      return { ok: false, error: `peer already holds ${label} — release it first (one channel per session)` };
    }
    return { ok: true };
  }

  return {
    canClaim,

    claim(peerId, channel, { channelName, sessionId } = {}) {
      const pre = canClaim(peerId, channel);
      if (!pre.ok) return pre;
      const data = load();
      const existing = data[channel];
      const now = new Date().toISOString();
      data[channel] = {
        peer_id: peerId,
        channel,
        channel_name: channelName ?? existing?.channel_name ?? null,
        session_id: sessionId ?? existing?.session_id ?? null,
        claimed_at: existing?.claimed_at ?? now,
        last_seen: now,
      };
      persist(data);
      return { ok: true };
    },

    release(peerId) {
      const data = load();
      for (const ch of Object.keys(data)) {
        if (data[ch].peer_id === peerId) delete data[ch];
      }
      persist(data);
      return { ok: true };
    },

    get(channel) {
      const data = load();
      return Object.hasOwn(data, channel) ? data[channel] : null;
    },

    all() {
      return { ...load() };
    },

    // Written before claim(), so a claim never exists without its record.
    recordHistory(channel, { session_id: sessionId = null, channel_name: channelName = null } = {}) {
      const data = loadHistory();
      const prev = data[channel] ?? {};
      data[channel] = { session_id: sessionId ?? prev.session_id ?? null, channel_name: channelName ?? prev.channel_name ?? null };
      const tmp = historyPath + ".tmp";
      mkdirSync(dirname(historyPath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmp, historyPath);
      historyCache = data;
      return { ok: true };
    },

    history(channel) {
      const data = loadHistory();
      return Object.hasOwn(data, channel) ? data[channel] : null;
    },

    close() { cache = null; historyCache = null; },
  };
}
