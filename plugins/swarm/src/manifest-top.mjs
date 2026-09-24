import { resolve } from "node:path";

// Keys only a top-level manifest may set; a child manifest runs inside its parent's run.
const RUN_KEYS = ["resultsDir", "concurrency", "digest", "cwd"];
// `description` is free text for the author — nothing reads it.
const TOP_KEYS = ["tasks", "goal", "timeoutMs", "description", ...RUN_KEYS];

// An unread key is a field the author thinks is live — a silently ignored `cwd` ran
// every leaf in the wrong repo.
function checkUnknownKeys(raw, where, errors) {
  for (const key of Object.keys(raw)) {
    if (TOP_KEYS.includes(key)) continue;
    errors.push(`${where}unknown top-level key '${key}' — a manifest's top level takes only ${TOP_KEYS.join(", ")}; per-task fields go inside each task, e.g. {"cwd": "C:/code/repo", "tasks": [{"id": "a", "prompt": "…"}]}`);
  }
}

// Validates the top-level keys and returns the manifest's effective cwd: its `cwd`,
// resolved against the dispatch cwd, runs the manifest as if swarm were launched there.
export function manifestCwd(raw, cwd, errors) {
  checkUnknownKeys(raw, "", errors);
  if (raw.cwd === undefined) return cwd;
  if (typeof raw.cwd === "string" && raw.cwd) return resolve(cwd, raw.cwd);
  errors.push(`cwd must be a non-empty path string — e.g. "cwd": "C:/code/repo" (got ${JSON.stringify(raw.cwd)})`);
  return cwd;
}

export function checkChildTopKeys(raw, where, errors) {
  for (const key of RUN_KEYS) {
    if (raw[key] !== undefined) errors.push(`${where}may not set ${key} — the parent owns the run`);
  }
  checkUnknownKeys(raw, where, errors);
}
