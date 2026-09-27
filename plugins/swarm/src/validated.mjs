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

export function markValidated(key, env = process.env) {
  mkdirSync(validatedDir(env), { recursive: true });
  writeFileSync(markerPath(key, env), JSON.stringify({ validatedAt: new Date().toISOString() }) + "\n");
}

export function isValidated(key, env = process.env) {
  return existsSync(markerPath(key, env));
}
