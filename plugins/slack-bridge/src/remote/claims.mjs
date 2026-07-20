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

  return {
    claim(peerId, channel, { channelName } = {}) {
      const data = load();
      const existing = data[channel];
      if (existing && existing.peer_id !== peerId) {
        return { ok: false, error: `channel ${channel} already claimed by ${existing.peer_id}` };
      }
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

    getByPeer(peerId) {
      const data = load();
      for (const ch of Object.keys(data)) {
        if (data[ch].peer_id === peerId) return data[ch];
      }
      return null;
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

    touch(peerId) {
      const data = load();
      for (const ch of Object.keys(data)) {
        if (data[ch].peer_id === peerId) data[ch].last_seen = new Date().toISOString();
      }
      persist(data);
    },

    close() { cache = null; },
  };
}