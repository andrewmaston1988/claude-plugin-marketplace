import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULTS_PATH = fileURLToPath(new URL("../config.default.json", import.meta.url));

// ~/.swarm — overridable via SWARM_HOME so tests never touch the real home dir.
export function swarmHome(env = process.env) {
  return env.SWARM_HOME || join(homedir(), ".swarm");
}

// Shipped leaf timeout: one hour of headroom. The single code-facing source;
// config.default.json mirrors it and config.test.mjs pins them together so the
// fallback sites (which import this) can never drift from the user-facing value.
export const DEFAULT_TIMEOUT_MS = 3_600_000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const KNOWN_PROJECT_HOOK_KEYS = new Set(["preToolUse"]);
const PROJECTS_EXAMPLE = '"projects": [{"name": "myrepo", "hooks": {"preToolUse": "cmd"}}]';

// Each entry: name (required, non-empty, unique) + hooks (required object;
// only preToolUse recognised today — the shape is reserved for later hook
// events, so an unknown key is a hard error naming the known ones).
function validateProjects(projects) {
  if (!Array.isArray(projects)) {
    throw new Error(`projects must be an array — e.g. ${PROJECTS_EXAMPLE} in ~/.swarm/config.json`);
  }
  const seen = new Set();
  projects.forEach((p, i) => {
    if (!isPlainObject(p) || typeof p.name !== "string" || !p.name) {
      throw new Error(`projects[${i}].name must be a non-empty string — e.g. ${PROJECTS_EXAMPLE}`);
    }
    if (seen.has(p.name)) {
      throw new Error(`projects[${i}].name '${p.name}' is a duplicate — project names must be unique`);
    }
    seen.add(p.name);
    if (!isPlainObject(p.hooks)) {
      throw new Error(`projects[${i}].hooks must be an object — e.g. ${PROJECTS_EXAMPLE}`);
    }
    for (const k of Object.keys(p.hooks)) {
      if (!KNOWN_PROJECT_HOOK_KEYS.has(k)) {
        throw new Error(`projects[${i}].hooks has unknown key '${k}' — known keys: ${[...KNOWN_PROJECT_HOOK_KEYS].join(", ")}`);
      }
    }
    if (p.hooks.preToolUse !== undefined && typeof p.hooks.preToolUse !== "string") {
      throw new Error(`projects[${i}].hooks.preToolUse must be a command string — e.g. ${PROJECTS_EXAMPLE}`);
    }
  });
}

// minFreeMemMb (spawn floor) and valveFreeMemMb (kill-newest-running valve) are
// both hard-error, not silent-fallback: a malformed value would arm/disarm
// memory protection without the user noticing. 0 is a valid value (disables
// that gate) — only non-integers and negatives are refused.
function validateMemFloor(cfg, key) {
  const v = cfg[key];
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`${key} must be a non-negative integer (MB) — e.g. "${key}": 2048 in ~/.swarm/config.json; 0 disables it`);
  }
}

// Deep merge: override wins; objects merge recursively; arrays and scalars replace.
export function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function normalizeConfigInput(input) {
  if (!isPlainObject(input)) throw new Error("swarm config must be an object");
  const user = input;
  for (const key of ["providers", "provider", "codex"]) {
    if (Object.hasOwn(user, key) && !isPlainObject(user[key])) {
      throw new Error(`${key} must be an object`);
    }
  }
  const normalized = {};
  for (const [key, value] of Object.entries(user)) {
    if (key !== "provider" && key !== "codex" && key !== "providers") normalized[key] = value;
  }
  const canonical = isPlainObject(user.providers) ? user.providers : {};
  normalized.providers = { ...canonical };
  if (isPlainObject(user.provider)) {
    normalized.providers.ollama = deepMerge(user.provider, canonical.ollama || {});
  }
  if (isPlainObject(user.codex)) {
    normalized.providers.codex = deepMerge(user.codex, canonical.codex || {});
  }
  return normalized;
}

// Legacy key -> the canonical path normalizeConfigInput folds it into. The one place
// the mapping lives: the fold targets it, the deprecation warning names it, and
// initConfig reports the migration through it.
export const LEGACY_KEY_TO_CANONICAL = {
  provider: "providers.ollama",
  codex: "providers.codex",
};

// The legacy keys actually present, in a fixed order so the warnings and the printed
// mapping are stable. Single source for both, and for initConfig's `migrated` flag.
function legacyKeys(input) {
  return Object.keys(LEGACY_KEY_TO_CANONICAL).filter((k) => isPlainObject(input?.[k]));
}

function legacyConfigWarnings(input) {
  return legacyKeys(input).map((k) => `swarm config key '${k}' is deprecated; move it to '${LEGACY_KEY_TO_CANONICAL[k]}'`);
}

// Both levels take the same shape. An empty array is valid and means "deny everything"
// — a deliberate denial, not the absence of configuration, so `undefined` is left alone.
function validateAllowedRoots(value, label) {
  if (value !== undefined && (!Array.isArray(value) || value.some((root) => typeof root !== "string" || !root))) {
    throw new Error(`${label} must be an array of non-empty path strings`);
  }
}

function validateProviderConfig(cfg) {
  if (!isPlainObject(cfg.providers)) throw new Error('providers must be an object — e.g. "providers": {"codex": {"enabled": false}}');
  // Top level is the default every provider inherits; a provider entry narrows it.
  validateAllowedRoots(cfg.allowedRoots, "allowedRoots");
  for (const [id, provider] of Object.entries(cfg.providers)) {
    if (!isPlainObject(provider)) throw new Error(`providers.${id} must be an object`);
    if (typeof provider.enabled !== "boolean") throw new Error(`providers.${id}.enabled must be true or false`);
    validateAllowedRoots(provider.allowedRoots, `providers.${id}.allowedRoots`);
  }
}

// Every check a config must pass, in one place: loadConfig runs it on the merged
// view, initConfig on the object it is about to write. Five checks — the
// valve/minFreeMemMb ordering below is the one an extraction keeps dropping.
function validateConfig(cfg) {
  validateProviderConfig(cfg);
  if (typeof cfg.disable1mContext !== "boolean") {
    throw new Error('disable1mContext must be true or false — e.g. "disable1mContext": false in ~/.swarm/config.json gives every Claude leaf the 1M window');
  }
  validateProjects(cfg.projects);
  validateMemFloor(cfg, "minFreeMemMb");
  validateMemFloor(cfg, "valveFreeMemMb");
  // minFreeMemMb: 0 is the documented "disabled" sentinel for the spawn floor —
  // the valve is then the only mechanism, so the ordering check doesn't apply.
  if (cfg.minFreeMemMb > 0 && cfg.valveFreeMemMb > cfg.minFreeMemMb) {
    throw new Error(`valveFreeMemMb (${cfg.valveFreeMemMb}) must not exceed minFreeMemMb (${cfg.minFreeMemMb}) — the valve would fire before the spawn floor ever parks a leaf; lower valveFreeMemMb or raise minFreeMemMb in ~/.swarm/config.json`);
  }
}

function addLegacyProviderView(cfg) {
  Object.defineProperty(cfg, "provider", {
    enumerable: false,
    configurable: false,
    get: () => cfg.providers.ollama,
  });
  return cfg;
}

// Merged config: config.default.json <- ~/.swarm/config.json (or explicit overridePath).
// A missing user config is fine; a malformed one is a hard error (silent fallback
// would arm/disarm the governance gate without the user noticing).
export function loadConfig(overridePath, env = process.env, { warn = (message) => process.emitWarning(message, "DeprecationWarning") } = {}) {
  const defaults = JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
  const userPath = overridePath || join(swarmHome(env), "config.json");
  const user = existsSync(userPath) ? parseUser(userPath) : null;
  for (const warning of legacyConfigWarnings(user)) warn(warning);
  const cfg = user ? deepMerge(defaults, normalizeConfigInput(user)) : defaults;
  validateConfig(cfg);
  return addLegacyProviderView(cfg);
}

// ---- the /swarm:swarm setup surface ---------------------------------------------
// The shipped config.default.json is overwritten on every plugin update, so the
// user's own file is the only durable place for the full picture. initConfig
// materialises every shipped key there (values already set are kept). Edits are
// hand-made in that file — the /swarm:swarm setup skill walks the keys with the user.

function parseUser(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`swarm config at ${path} is not valid JSON: ${e.message}`);
  }
}

function readDefaults() {
  return JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
}

function writeAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(obj, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

// Depth-first leaf paths of a defaults tree; objects recurse, arrays/scalars are leaves.
function leafKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    // An empty object (e.g. leafGuards: {}) is a leaf too — recursing into it
    // yields nothing, so initConfig would never materialise the shipped key.
    if (isPlainObject(v) && Object.keys(v).length) out.push(...leafKeys(v, key)); else out.push(key);
  }
  return out;
}

function getPath(obj, key) {
  let cur = obj;
  for (const k of key.split(".")) {
    if (!isPlainObject(cur) || !(k in cur)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

function setPath(obj, key, value) {
  const ks = key.split(".");
  let cur = obj;
  for (const k of ks.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[ks[ks.length - 1]] = value;
}

export function userConfigPath(overridePath, env = process.env) {
  return overridePath || join(swarmHome(env), "config.json");
}

// A refusal has to name the key the operator actually wrote: they have "provider",
// not "providers.ollama", and a complaint about a path they have never seen reads as
// a swarm bug rather than a value to go and fix.
function refuseToWrite(raw, path, migrated, err) {
  const head = migrated ? `cannot migrate ${path}` : `cannot write ${path}`;
  const tail = "Nothing was written. Fix the value and re-run `swarm config init`.";
  if (migrated) {
    for (const [legacy, canonical] of Object.entries(LEGACY_KEY_TO_CANONICAL)) {
      const prefix = `${canonical}.`;
      const at = err.message.indexOf(prefix);
      if (at < 0 || !isPlainObject(raw[legacy])) continue;
      const leaf = err.message.slice(at).match(/^[\w.$]+/)[0];
      return `${head}: ${err.message.replace(prefix, `${legacy}.`)}\n  (it becomes ${leaf}, which swarm validates on every load)\n${tail}`;
    }
  }
  return `${head}: ${err.message}\n${tail}`;
}

// Write every shipped key into the user file, keeping whatever is already set. An
// old-shaped file is folded to the canonical shape in the same pass, so the operator's
// file stops carrying keys swarm only tolerates.
// Returns { path, created, migrated, migratedKeys, added } — added = leaf keys filled
// in this call, migratedKeys = the legacy keys the fold rewrote.
export function initConfig(overridePath, env = process.env) {
  const path = userConfigPath(overridePath, env);
  const defaults = readDefaults();
  const created = !existsSync(path);
  const raw = created ? {} : parseUser(path);
  const migratedKeys = created ? [] : legacyKeys(raw);
  const user = normalizeConfigInput(raw);
  const added = [];
  for (const key of leafKeys(defaults)) {
    if (getPath(user, key).found) continue;
    setPath(user, key, getPath(defaults, key).value);
    added.push(key);
  }
  // Validate AFTER the fill, immediately before the write. A sparse legacy file
  // ({"provider": {}}) sets no `enabled` of its own and is only valid once the
  // defaults supply it, so judging the fragment would refuse a file that loads fine
  // today. A write the next loadConfig rejects is worse than a refusal: the operator
  // loses the shape they understood and gains one that does not load.
  try {
    validateConfig(user);
  } catch (e) {
    throw new Error(refuseToWrite(raw, path, migratedKeys.length > 0, e));
  }
  // Only a migration keeps a backup: the added.length path fires on every plugin
  // update that ships a key, and a backup churned that often answers nothing.
  if (migratedKeys.length) writeAtomic(path + ".bak", raw);
  if (created || migratedKeys.length || added.length) writeAtomic(path, user);
  return { path, created, migrated: migratedKeys.length > 0, migratedKeys, added };
}
