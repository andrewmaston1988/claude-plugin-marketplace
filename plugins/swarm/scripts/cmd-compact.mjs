// `swarm compact` — strip inline image bytes from leaf transcripts already on disk.
// It applies the same per-line function the live filter uses, so a compacted run and
// a fresh one have identical shape; only the bytes go. Files are rewritten through a
// `.tmp` sibling and renamed, so a torn write can never leave half a transcript, and
// a run the shared liveness rule calls alive is skipped rather than rewritten under a
// running leaf.
import * as fs from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { basename, dirname, join, resolve } from "node:path";
import { stripImages } from "../src/log-line-filter.mjs";
import { runLiveness } from "../src/runlog.mjs";
import { out, err } from "../src/ui.mjs";

const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 50;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const formatBytes = (n) => (n >= 1024 ** 2
  ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// Matched by shape (`<run>/results/<id>.log`), never by depth: the same path is a
// results dir, a run dir or a runs root depending on what the operator typed. A
// `*.ask.log` is plain-text Q/A, not a stream, so it is never a transcript.
function transcriptFiles(_fs, root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = _fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || basename(dir) !== "results") continue;
      if (entry.name.endsWith(".ask.log")) continue;
      if (entry.name.endsWith(".log") || entry.name.endsWith(".log.gz")) found.push(path);
    }
  };
  walk(resolve(root));
  return found.sort();
}

async function* transcriptLines(_fs, file, gz) {
  const source = _fs.createReadStream(file);
  const stream = gz ? source.pipe(createGunzip()) : source;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) yield line;
}

// EPERM against a concurrent reader is the known Windows failure (see results.mjs);
// a few quick retries cover it, and anything else fails straight away.
async function renameWithRetry(_fs, from, to) {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      _fs.renameSync(from, to);
      return true;
    } catch (e) {
      if (!RETRYABLE_RENAME_CODES.has(e?.code)) return false;
      if (attempt < RENAME_ATTEMPTS) await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS * attempt));
    }
  }
  return false;
}

function removeQuietly(_fs, path) {
  try { _fs.unlinkSync(path); } catch { /* already gone */ }
}

// { before, after } in bytes, or { skipped: reason }. Bytes are counted as the stream
// is read, so a dry run measures the same numbers without writing anything.
async function compactFile(file, { _fs, dryRun }) {
  const gz = file.endsWith(".log.gz");
  const target = gz ? file.slice(0, -3) : file;
  // A resumed run may have written a newer plain transcript beside an older .gz;
  // that plain file is the one with the current attempt history.
  if (gz && _fs.existsSync(target)) {
    return { skipped: "a sibling .log exists — a resumed run wrote a newer transcript" };
  }
  const tmp = `${target}.tmp`;
  let before = 0;
  let after = 0;
  const writer = dryRun ? null : _fs.createWriteStream(tmp);
  try {
    for await (const line of transcriptLines(_fs, file, gz)) {
      const raw = Buffer.from(line + "\n", "utf8");
      before += raw.length;
      const stripped = stripImages(raw);
      after += stripped.length;
      if (writer && !writer.write(stripped)) await once(writer, "drain");
    }
    if (writer) {
      writer.end();
      await finished(writer);
    }
  } catch (e) {
    writer?.destroy();
    removeQuietly(_fs, tmp);
    return { skipped: `unreadable (${e?.code || e?.message})` };
  }
  if (dryRun) return { before, after };
  if (!(await renameWithRetry(_fs, tmp, target))) {
    removeQuietly(_fs, tmp);
    return { skipped: "the rename failed — the original is untouched" };
  }
  // Only once the plain transcript is in place: the .gz is the last copy of the
  // bytes until the rename lands.
  if (gz) removeQuietly(_fs, file);
  return { before, after };
}

export async function cmdCompact(rest, { usage, _fs = fs, now } = {}) {
  const target = rest.find((arg) => !arg.startsWith("--"));
  if (!target) { err(usage); return 1; }
  const root = resolve(target);
  if (!_fs.existsSync(root)) { err(`swarm: no such path: ${root}`); return 1; }
  const dryRun = rest.includes("--dry-run");
  const files = transcriptFiles(_fs, root);
  if (!files.length) { out(`swarm: no transcripts under ${root}`); return 0; }

  const byRun = new Map();
  for (const file of files) {
    const runDir = dirname(dirname(file));
    if (!byRun.has(runDir)) byRun.set(runDir, []);
    byRun.get(runDir).push(file);
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let compacted = 0;
  let skipped = 0;
  for (const [runDir, runFiles] of [...byRun].sort(([a], [b]) => a.localeCompare(b))) {
    const live = runLiveness(runDir, now ? { now } : {});
    if (live.finishedMs == null && live.stoppedMs == null && live.abortedMs == null) {
      err(`  ${runDir}: live — skipped, its leaf may still be writing`);
      skipped += runFiles.length;
      continue;
    }
    let runBefore = 0;
    let runAfter = 0;
    for (const file of runFiles) {
      const result = await compactFile(file, { _fs, dryRun });
      if (result.skipped) {
        err(`  ${file}: skipped — ${result.skipped}`);
        skipped++;
        continue;
      }
      runBefore += result.before;
      runAfter += result.after;
      compacted++;
    }
    if (runBefore === 0 && runAfter === 0) continue;
    out(`  ${runDir}: ${formatBytes(runBefore)} → ${formatBytes(runAfter)}${dryRun ? " (dry run)" : ""}`);
    totalBefore += runBefore;
    totalAfter += runAfter;
  }
  out(`swarm compact: ${compacted} transcript(s) ${dryRun ? "would shrink" : "shrank"} `
    + `${formatBytes(totalBefore)} → ${formatBytes(totalAfter)}${skipped ? `, ${skipped} skipped` : ""}`);
  return 0;
}
