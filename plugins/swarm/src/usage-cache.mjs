// The one caching rule every provider's usage reading obeys. Under five minutes
// the cache answers; past it the caller's fetchLive runs and its result is banked.
// A failed live read never costs the last reading — it is served as stale, with
// the moment it was actually read, because a reading with a timestamp is honest
// and no reading at all is not.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { swarmHome } from "./config.mjs";

export const USAGE_TTL_MS = 5 * 60_000;

// Anthropic's quota TTL is the same five minutes with a config override. It
// lives here, beside the constant it defaults to, because two readers compare
// against it — the live path and the cache-only adapter branch — and they must
// expire together.
export const quotaTtlMs = (cfg = {}) => (cfg.quotaCacheSecs ?? USAGE_TTL_MS / 1000) * 1000;

const CACHE_FILENAME = {
  claude: "quota-cache.json",
  codex: "codex-usage.json",
  ollama: "ollama-usage.json",
};

export function usageCachePath(provider, env = process.env) {
  return join(swarmHome(env), CACHE_FILENAME[provider] ?? `${provider}-usage.json`);
}

// A writer's own tmp name: two processes banking at once must not share one.
export function usageTmpPath(cachePath, pid = process.pid) {
  return `${cachePath}.${pid}.tmp`;
}

const pathOf = (provider, opts) => opts.cachePath ?? usageCachePath(provider, opts.env);
const ttlOf = (opts) => opts.ttlMs ?? USAGE_TTL_MS;

// Anything that is not a whole envelope reads as no cache at all, so an older
// on-disk shape costs one live read rather than a wrong number.
function parseEnvelope(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.fetchedAt !== "number" || !raw.result || typeof raw.result !== "object") return null;
  return raw;
}

export function readUsageEnvelope(provider, opts = {}) {
  const cachePath = pathOf(provider, opts);
  try {
    return parseEnvelope(JSON.parse(readFileSync(cachePath, "utf8")));
  } catch {
    return null;
  }
}

// A cache is garnish, never a prerequisite: a read-only home, an EPERM rename
// or an ENOSPC must not cost the reading that was just fetched, so every fs
// failure here is swallowed and the in-memory envelope is still the answer.
function writeEnvelope(envelope, { cachePath, pid }) {
  try {
    const tmp = usageTmpPath(cachePath, pid);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(envelope, null, 2));
    renameSync(tmp, cachePath);
  } catch {
    // best-effort by design
  }
  return envelope;
}

// The reader's shape: whatever `result` held, plus how to read it — provenance
// and the moment it was fetched. The failure note rides along when one is
// banked: it is why the reading is not this process's own fetch.
function flatten(envelope, fallbackProvider, provenance) {
  return {
    ...envelope.result,
    provider: envelope.result.provider ?? fallbackProvider,
    provenance,
    fetchedAt: envelope.fetchedAt,
    asOf: new Date(envelope.fetchedAt).toISOString(),
    ...(envelope.lastError != null
      && { lastError: envelope.lastError, lastErrorAt: envelope.lastErrorAt ?? null }),
  };
}

export function writeUsageReading(provider, { fetchedAt, result }, opts = {}) {
  const cachePath = pathOf(provider, opts);
  const prior = readUsageEnvelope(provider, { cachePath }) ?? {};
  return writeEnvelope({ ...prior, fetchedAt, result }, { cachePath, pid: opts.pid });
}

// Merge, never replace: the endpoint's own hold and the last failure are facts
// about the provider that a later successful read does not undo.
export function patchUsageEnvelope(provider, patch, opts = {}) {
  const cachePath = pathOf(provider, opts);
  const prior = readUsageEnvelope(provider, { cachePath });
  if (!prior) return null;
  return writeEnvelope({ ...prior, ...patch }, { cachePath, pid: opts.pid });
}

export function recordUsageError(provider, reason, opts = {}) {
  return patchUsageEnvelope(provider, { lastError: reason, lastErrorAt: opts.at ?? Date.now() }, opts);
}

export function cachedUsageReading(provider, opts = {}) {
  const cachePath = pathOf(provider, opts);
  const cached = readUsageEnvelope(provider, { cachePath });
  if (!cached) return null;
  const now = opts.now ? opts.now() : Date.now();
  return flatten(cached, provider, now - cached.fetchedAt < ttlOf(opts) ? "cached" : "stale");
}

export async function usageReading(provider, opts = {}) {
  const { fetchLive, force = false, pid } = opts;
  const cachePath = pathOf(provider, opts);
  const now = opts.now ? opts.now() : Date.now();
  const cached = readUsageEnvelope(provider, { cachePath });
  const fresh = cached != null && now - cached.fetchedAt < ttlOf(opts);

  if (fetchLive && (force || !fresh)) {
    let result = null;
    try {
      result = await fetchLive({ cached });
    } catch {
      result = null;
    }
    // A live read that yields nothing leaves the cache untouched, so the stale
    // reading below still carries the moment it really was read.
    if (result) {
      const banked = writeUsageReading(provider, { fetchedAt: now, result }, { cachePath, pid });
      return flatten(banked, provider, "live");
    }
  }
  if (!cached) return null;
  return flatten(cached, provider, fresh ? "cached" : "stale");
}
