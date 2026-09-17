// Claim store: maps a Slack channel id → the live-session peer-id that seized it.
// Atomic JSON writes (session-store pattern: tmp + rename). A channel claimed by
// peer A is rejected if peer B tries to claim it; the same peer re-claiming is
// idempotent. reapDead drops claims whose peer-id fails broker liveness.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function createClaimsStore({ path, log }) {
  let cache = null;

  function load() {
    if (cache !== null) return cache;
    if (!existsSync(path)) { cache = {}; return cache; }
    try {
      cache = JSON.parse(readFileSync(path, "utf8"));
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
    } catch (e) {
      log?.warn("claims store corrupt, starting fresh", { path, error: e.message });
      cache = {};
    }
    return cache;
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
    const existing = data[channel];
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

    claim(peerId, channel, { channelName } = {}) {
      const pre = canClaim(peerId, channel);
      if (!pre.ok) return pre;
      const data = load();
      const existing = data[channel];
      const now = new Date().toISOString();
      data[channel] = {
        peer_id: peerId,
        channel,
        channel_name: channelName ?? existing?.channel_name ?? null,
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
      return load()[channel] ?? null;
    },

    all() {
      return { ...load() };
    },

    // broker: { isAlive(peerId): Promise<bool> }. Returns the reaped peer-ids.
    async reapDead(broker) {
      const data = load();
      const reaped = [];
      for (const ch of Object.keys(data)) {
        const claim = data[ch];
        let alive = true;
        try { alive = await broker.isAlive(claim.peer_id); } catch { alive = false; }
        if (!alive) {
          reaped.push(claim.peer_id);
          delete data[ch];
        }
      }
      persist(data);
      return reaped;
    },

    close() { cache = null; },
  };
}
