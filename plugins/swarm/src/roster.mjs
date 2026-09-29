// Owns the model roster file: where discovered rows are banked, when each
// provider's entry goes stale, and the one reader every caller goes through.

import { mkdirSync, writeFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { swarmHome } from "./config.mjs";
import { createDefaultProviderRegistry } from "./providers.mjs";
import { mergeProviderModelCaches, providerQualifiedModels } from "./discovery.mjs";

// One file, one entry per provider: each goes stale for its own reason.

// Network providers age on the same 12h the price cards do, so a roster and the
// prices drawn from it are never half a day apart.
export const ROSTER_TTL_MS = 12 * 60 * 60_000;

const ROSTER_FILENAME = "models-cache.json";
export const rosterPath = (env) => join(swarmHome(env), ROSTER_FILENAME);

// A writer's own tmp name: two processes banking at once must not share one.
const rosterTmpPath = (env, pid = process.pid) => `${rosterPath(env)}.${pid}.tmp`;

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Missing file is a first-ever install. Anything else is loud: a truncated cache
// must never read as an empty roster, which would blank the one the operator can
// still dispatch from.
export function readRosterFile(env) {
  const p = rosterPath(env);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`models cache is unreadable: ${p} (${error?.message || error})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`models cache is unreadable: ${p} (${error?.message || error})`);
  }
}

export function writeRosterFile(value, env) {
  const dir = swarmHome(env);
  mkdirSync(dir, { recursive: true });
  const tmp = rosterTmpPath(env);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, rosterPath(env));
  return rosterPath(env);
}

export const writeRosterEnvelope = (providers, env) => writeRosterFile({ providers }, env);

// The old flat `{ updated, models }` file, banked per provider at the file's own
// mtime so its rows read as their true age and renew on the normal TTL. Rows with
// no provider cannot be placed: dropped and reported.
function carryForward(flat, env) {
  const hydratedAt = statSync(rosterPath(env)).mtimeMs;
  const byProvider = {};
  const errors = {};
  for (const row of Array.isArray(flat?.models) ? flat.models : []) {
    if (!row?.provider) {
      errors["migrate:" + (row?.model ?? "?")] = `old-shape roster row "${row?.model ?? "?"}" has no provider — dropped`;
      continue;
    }
    (byProvider[row.provider] ||= []).push(row);
  }
  const providers = {};
  for (const [id, models] of Object.entries(byProvider)) providers[id] = { hydratedAt, source: null, models };
  writeRosterEnvelope(providers, env);
  return { providers, errors };
}

// The roster as every reader sees it. An absent or old-shape file is carried
// forward (network-free) and rewritten in the envelope shape.
export function readRosterEnvelope(env = process.env) {
  const parsed = readRosterFile(env);
  if (isPlainObject(parsed?.providers)) return { providers: parsed.providers, errors: {} };
  if (parsed === null) return { providers: {}, errors: {} };
  return carryForward(parsed, env);
}

// Re-read, replace one entry, rename. The read is inside the write because the
// other providers' entries are the rows this one must not disturb.
export function writeRosterEntry(provider, entry, env = process.env) {
  writeRosterEnvelope({ ...readRosterEnvelope(env).providers, [provider]: entry }, env);
  return entry;
}

// Every entry's rows as one flat list, deduped by identity — the composite the
// single flat cache used to hold.
export function rosterModels(providers = {}) {
  return mergeProviderModelCaches(Object.values(providers).map((entry) => entry?.models || []));
}

const hydrationOf = (adapter) => adapter.rosterHydration ?? "network";

function rosterStale(adapter, entry, context) {
  const declared = adapter.capabilities.rosterStale;
  if (declared) return declared(entry, context);
  if (!entry) return true;
  return context.now - Math.max(entry.hydratedAt, entry.lastAttemptAt ?? 0) >= ROSTER_TTL_MS;
}

export function rosterSource(registry, adapter, context) {
  const declared = registry.capability(adapter.id, "rosterSource");
  return declared ? declared(context) : null;
}

// The zero-row rules, in one place: an empty answer over cached rows keeps them
// and says why; a first-ever empty is written without an error, because "this
// provider has no models" is not the same answer as "the fetch failed".
export function bankRosterEntry(id, { rows, prior, source, now, env, errors }) {
  const models = providerQualifiedModels(id, rows);
  if (!models.length && prior?.models?.length) {
    const message = `model discovery returned no rows for ${id} — kept the ${prior.models.length} cached model(s)`;
    errors[id] = message;
    writeRosterEntry(id, { ...prior, source, lastError: message, lastAttemptAt: now }, env);
    return;
  }
  writeRosterEntry(id, { hydratedAt: now, source, models }, env);
}

export function recordRosterFailure(id, error, { prior, env, errors, now }) {
  const message = error?.message || String(error);
  errors[id] = message;
  writeRosterEntry(id, { hydratedAt: 0, source: null, models: [], ...prior, lastError: message, lastAttemptAt: now }, env);
}

// The one reader. Local hydrations run inline — Claude's catalog is a file on
// this machine — and network ones never do: validate, run and the dashboard call
// this on a synchronous path, so it must not await anything.
export function modelRoster({ env = process.env, config = {}, registry, now = Date.now() } = {}) {
  const providers = registry || createDefaultProviderRegistry();
  let envelope;
  try {
    envelope = readRosterEnvelope(env);
  } catch (error) {
    return { models: [], errors: { file: error.message } };
  }
  const errors = { ...envelope.errors };
  for (const adapter of providers.list()) {
    if (hydrationOf(adapter) !== "local" || !adapter.enabled(config)) continue;
    const entry = envelope.providers[adapter.id];
    const context = { config, env, now };
    if (!rosterStale(adapter, entry, context)) continue;
    const discover = providers.capability(adapter.id, "discoverModels");
    if (!discover) continue;
    let rows;
    try {
      rows = discover({ config, env, rich: false });
    } catch (error) {
      recordRosterFailure(adapter.id, error, { prior: entry, env, errors, now });
      continue;
    }
    // A promise here would make the reader async and put a network call on
    // validate's path. Refuse it and serve what is already banked.
    if (rows && typeof rows.then === "function") {
      errors[adapter.id] = `local hydration for ${adapter.id} must be synchronous — serving the cached rows`;
      continue;
    }
    bankRosterEntry(adapter.id, {
      rows: Array.isArray(rows) ? rows : [],
      prior: entry,
      source: rosterSource(providers, adapter, { config, env, now }),
      now,
      env,
      errors,
    });
  }
  return { models: rosterModels(readRosterEnvelope(env).providers), errors };
}

// The network half, called only where a network call is already expected:
// `swarm models`, and the dashboard's background fire.
export async function refreshRoster({
  env = process.env, config = {}, registry, now = Date.now(), force = false, rich = false, fetchImpl, spawnImpl,
} = {}) {
  const providers = registry || createDefaultProviderRegistry();
  // Read first: an unreadable cache must throw before anything is written.
  const envelope = readRosterEnvelope(env);
  const errors = { ...envelope.errors };
  for (const adapter of providers.list()) {
    if (hydrationOf(adapter) !== "network" || !adapter.enabled(config)) continue;
    const entry = envelope.providers[adapter.id];
    if (!force && !rosterStale(adapter, entry, { config, env, now })) continue;
    const discover = providers.capability(adapter.id, "discoverModels");
    if (!discover) continue;
    const prior = readRosterEnvelope(env).providers[adapter.id];
    const source = rosterSource(providers, adapter, { config, env, now });
    try {
      const rows = await discover({ config, env, fetchImpl, spawnImpl, rich });
      bankRosterEntry(adapter.id, { rows: Array.isArray(rows) ? rows : [], prior, source, now, env, errors });
    } catch (error) {
      recordRosterFailure(adapter.id, error, { prior, env, errors, now });
    }
  }
  return { models: rosterModels(readRosterEnvelope(env).providers), errors };
}
