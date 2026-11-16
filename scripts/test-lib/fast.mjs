// What `--fast` may skip, from what this machine last measured.
//
// A recorded duration is a licence to skip only while it still describes the
// run that would happen now: the file's bytes are the same, the measurement is
// recent, and it was genuinely slow. Any doubt runs the file and re-measures.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

export const SLOW_FILE_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_AGE_MS = 7 * DAY_MS;
const TIMINGS_NAME = "timings.json";

/** Timings key. Repo-relative, posix, so the swarm and pipeline suites never
 *  collide over a shared basename and a worktree keys like its main checkout. */
export function timingKey(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function timingsPath(resultsDir) {
  return join(resultsDir, TIMINGS_NAME);
}

function fileHash(repoRoot, file, _readFileSync) {
  try {
    return createHash("sha256").update(_readFileSync(join(repoRoot, file))).digest("hex");
  } catch {
    return null; // a deleted or unreadable file was never measured as it is now
  }
}

/** Recorded entries, or `{}`. A missing or corrupt cache means run everything;
 *  it must never fail a test run. */
export function readTimings(resultsDir, { _readFileSync = nodeFs.readFileSync } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(_readFileSync(timingsPath(resultsDir), "utf8")));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [rawFile, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    const ms = Number(entry.ms);
    const at = Number(entry.at);
    if (!Number.isFinite(ms) || !Number.isFinite(at)) continue;
    out[timingKey(rawFile)] = { ms, sha256: String(entry.sha256 ?? ""), at };
  }
  return out;
}

export function mergeTimings(timings, updates) {
  const out = { ...timings };
  for (const [file, entry] of Object.entries(updates)) out[timingKey(file)] = entry;
  return out;
}

/** Hash each finished file as it is now, stamp the clock, and merge into the
 *  cache. Concurrent runs can lose one sample; tmp+rename means the file is
 *  never half-written. Returns `{ ok }` rather than throwing: the cache is an
 *  optimisation, never a reason for a test run to fail. */
export function recordTimings({
  resultsDir,
  repoRoot,
  entries,
  now = Date.now,
  _fs = nodeFs,
} = {}) {
  const timings = readTimings(resultsDir, { _readFileSync: _fs.readFileSync });
  const at = now();
  for (const { file, ms } of entries) {
    if (!Number.isFinite(ms) || ms < 0) continue;
    const sha256 = fileHash(repoRoot, file, _fs.readFileSync);
    if (sha256 === null) continue;
    timings[timingKey(file)] = { ms, sha256, at };
  }
  const path = timingsPath(resultsDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    _fs.mkdirSync(dirname(path), { recursive: true });
    _fs.writeFileSync(tmp, `${JSON.stringify(timings, null, 2)}\n`);
    _fs.renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The files `--fast` skips: recorded over the bar, measured within the age
 *  limit, and byte-identical to what ran. Sorted, so the skip list reads the
 *  same on every run. */
export function slowFiles(timings, { repoRoot, now = Date.now, _readFileSync = nodeFs.readFileSync } = {}) {
  const out = [];
  for (const [file, entry] of Object.entries(timings)) {
    if (!(entry.ms > SLOW_FILE_MS)) continue;
    if (!(now() - entry.at < MAX_AGE_MS)) continue;
    if (entry.sha256 !== fileHash(repoRoot, file, _readFileSync)) continue;
    out.push({ file, ms: entry.ms });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
