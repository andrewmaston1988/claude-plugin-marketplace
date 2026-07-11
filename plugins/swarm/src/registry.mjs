// Manifest registry — resolve `run <name>` / `validate <name>` against saved
// manifests. Two scopes, one shape: <cwd>/.swarm/manifests/<name>.json (local)
// and <swarmHome()>/manifests/<name>.json (global). The name is a LOOKUP, never
// a hiding place: resolution is syntactic (no existsSync shadowing), collisions
// fail loudly, and the caller prints where the name landed.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { swarmHome } from "./config.mjs";
import { ValidationError, readManifestJson } from "./manifest.mjs";

// Same charset as manifest task ids; a ref that doesn't parse as a name and
// isn't a path is an immediate teaching error, not a probe.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A ref is a path iff it contains a separator or ends in .json — deterministic,
// so a stray file named `audit` in cwd can never shadow a registry name and
// `./audit.json` is always the file.
export function isPathRef(ref) {
  return ref.includes("/") || ref.includes("\\") || /\.json$/i.test(ref);
}

function registryDirs(cwd, env) {
  return [
    { scope: "local", dir: join(cwd, ".swarm", "manifests") },
    { scope: "global", dir: join(swarmHome(env), "manifests") },
  ];
}

function savedNames(cwd, env) {
  const names = [];
  for (const { scope, dir } of registryDirs(cwd, env)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (/\.json$/i.test(entry)) names.push({ name: entry.replace(/\.json$/i, ""), scope, path: join(dir, entry) });
    }
  }
  return names;
}

export function resolveRef(ref, cwd, env = process.env) {
  if (isPathRef(ref)) return { path: resolve(cwd, ref), source: "path" };
  if (!NAME_RE.test(ref)) {
    throw new ValidationError([
      `'${ref}' is not a valid manifest name — names use [A-Za-z0-9._-] and start with a letter or digit; for a file, pass a path ending in .json`,
    ]);
  }
  const hits = registryDirs(cwd, env)
    .map(({ scope, dir }) => ({ scope, path: join(dir, `${ref}.json`) }))
    .filter((h) => existsSync(h.path));
  if (hits.length > 1) {
    throw new ValidationError([
      `manifest name '${ref}' exists in both scopes — disambiguate with an explicit path:\n` +
      hits.map((h) => `    ${h.path} (${h.scope})`).join("\n"),
    ]);
  }
  if (hits.length === 0) {
    const saved = savedNames(cwd, env);
    const listing = saved.length
      ? `saved manifests: ${saved.map((s) => `${s.name} (${s.scope})`).join(", ")}`
      : "(none saved — save one as <cwd>/.swarm/manifests/<name>.json or ~/.swarm/manifests/<name>.json)";
    throw new ValidationError([`no saved manifest named '${ref}' — ${listing}`]);
  }
  return { path: hits[0].path, source: hits[0].scope };
}

// Registry inventory for the `list` subcommand: merged scopes, name-sorted,
// goal peeked best-effort (a malformed saved file lists as unreadable rather
// than breaking the listing), collisions flagged on both entries.
export function listManifests(cwd, env = process.env) {
  const entries = savedNames(cwd, env).map((s) => ({ ...s, goal: peekGoal(s.path) }));
  const counts = new Map();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) || 0) + 1);
  for (const e of entries) {
    if (counts.get(e.name) > 1) e.collision = true;
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope.localeCompare(b.scope)));
}

function peekGoal(path) {
  try {
    const goal = readManifestJson(path).goal;
    return typeof goal === "string" ? goal : "";
  } catch {
    return "(unreadable)";
  }
}
