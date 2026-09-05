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

// Deep merge: override wins; objects merge recursively; arrays and scalars replace.
export function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Merged config: config.default.json <- ~/.swarm/config.json (or explicit overridePath).
// A missing user config is fine; a malformed one is a hard error (silent fallback
// would arm/disarm the governance gate without the user noticing).
export function loadConfig(overridePath, env = process.env) {
  const defaults = JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
  const userPath = overridePath || join(swarmHome(env), "config.json");
  if (!existsSync(userPath)) return defaults;
  return deepMerge(defaults, parseUser(userPath));
}

// ---- the /swarm:setup surface ---------------------------------------------
// The shipped config.default.json is overwritten on every plugin update, so the
// user's own file is the only durable place for the full picture. initConfig
// materialises every shipped key there (values already set are kept). Edits are
// hand-made in that file — the /swarm:setup skill walks the keys with the user.

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
    if (isPlainObject(v)) out.push(...leafKeys(v, key)); else out.push(key);
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

// Write every shipped key into the user file, keeping whatever is already set.
// Returns { path, created, added } — added = leaf keys filled in this call.
export function initConfig(overridePath, env = process.env) {
  const path = userConfigPath(overridePath, env);
  const defaults = readDefaults();
  const created = !existsSync(path);
  const user = created ? {} : parseUser(path);
  const added = [];
  for (const key of leafKeys(defaults)) {
    if (getPath(user, key).found) continue;
    setPath(user, key, getPath(defaults, key).value);
    added.push(key);
  }
  if (created || added.length) writeAtomic(path, user);
  return { path, created, added };
}


