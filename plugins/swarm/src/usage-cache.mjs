// The one caching rule every provider's usage reading obeys. Under five minutes
// the cache answers; past it the caller's fetchLive runs and its result is banked.
// A failed live read never costs the last reading — it is served as stale, with
// the moment it was actually read, because a reading with a timestamp is honest
// and no reading at all is not.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { swarmHome } from "./config.mjs";

export const USAGE_TTL_MS = 5 * 60_000;

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

function writeEnvelope(envelope, { cachePath, pid }) {
  const tmp = usageTmpPath(cachePath, pid);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(envelope, null, 2));
  renameSync(tmp, cachePath);
  return envelope;
}

// The reader's shape: whatever `result` held, plus how to read it — provenance
// and the moment it was fetched.
function flatten(envelope, fallbackProvider, provenance) {
  return {
    ...envelope.result,
    provider: envelope.result.provider ?? fallbackProvider,
    provenance,
    fetchedAt: envelope.fetchedAt,
    asOf: new Date(envelope.fetchedAt).toISOString(),
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
  return flatten(cached, provider, now - cached.fetchedAt < USAGE_TTL_MS ? "cache" : "stale");
}

export async function usageReading(provider, opts = {}) {
  const { fetchLive, force = false, pid } = opts;
  const cachePath = pathOf(provider, opts);
  const now = opts.now ? opts.now() : Date.now();
  const cached = readUsageEnvelope(provider, { cachePath });
  const fresh = cached != null && now - cached.fetchedAt < USAGE_TTL_MS;

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
  return flatten(cached, provider, fresh ? "cache" : "stale");
}
