// The dispatch gate's marker store: `run` refuses a manifest unless `validate`
// has passed on the very bytes and args it is being given.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { swarmHome } from "./config.mjs";
import { canonicalize } from "./manifest.mjs";

export function validatedDir(env = process.env) {
  return join(swarmHome(env), "validated");
}

export function markerPath(key, env = process.env) {
  return join(validatedDir(env), key);
}

// The raw bytes of the manifest and of every child manifest it loads, in load
// order, plus the canonicalised args. Nothing the engine DERIVES goes in: a
// resolved effort moves with models-cache.json, a default resultsDir with the
// sibling run dirs, a task cwd with the invoking directory — none of those are
// what the author wrote, so none of them may move the key.
export function validationKey(files, args = null) {
  const h = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(file);
    // Length-prefixed: two short files must never collide with one long one.
    h.update(`${bytes.length}\n`);
    h.update(bytes);
  }
  h.update(JSON.stringify(canonicalize(args)));
  return h.digest("hex");
}

export function isValidated(key, env = process.env) {
  return existsSync(markerPath(key, env));
}

// `validate`'s success path. Returns 0 so the verb can `return markValidated(...)`
// and the write cannot be dropped from a later edit to cmdValidate's tail.
export function markValidated(plan, args) {
  const key = validationKey(plan.manifestFiles, args);
  mkdirSync(validatedDir(), { recursive: true });
  writeFileSync(markerPath(key), JSON.stringify({ validatedAt: new Date().toISOString() }) + "\n");
  return 0;
}

// The refusal `run` prints when the marker is missing, or null when it is there.
// The key that decides and the line that teaches live together: a run refused
// here must name the exact command — args included — that would have covered it.
export function unvalidatedRefusal(plan, args, ref) {
  if (isValidated(validationKey(plan.manifestFiles, args))) return null;
  const shown = args ? `${ref} --args '${JSON.stringify(args)}'` : ref;
  return `swarm: ${shown} has not been validated as written — run \`swarm validate ${shown}\` and read its seats block, then run again.`;
}
