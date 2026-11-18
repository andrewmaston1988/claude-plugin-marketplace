// `swarm compact` — strip inline image bytes from leaf transcripts already on disk.
import * as fs from "node:fs";
import { createGunzip } from "node:zlib";
import { basename, dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createLogLineFilter } from "../src/log-line-filter.mjs";
import { runLiveness } from "../src/runlog.mjs";
import { getConfig } from "../src/config.mjs";
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

// { before, after, changed } in on-disk bytes, or { skipped: reason, failed? }.
// Nothing stripped leaves the file alone — a `.gz` stays compressed and `.tmp` goes.
async function compactFile(file, { _fs, dryRun }) {
  const gz = file.endsWith(".log.gz");
  const target = gz ? file.slice(0, -3) : file;
  // A resumed run may have written a newer plain transcript beside an older .gz;
  // that plain file is the one with the current attempt history.
  if (gz && _fs.existsSync(target)) {
    return { skipped: "a sibling .log exists — a resumed run wrote a newer transcript" };
  }
  let before;
  try {
    before = _fs.statSync(file).size;
  } catch (e) {
    return { skipped: `unreadable (${e?.code || e?.message})`, failed: true };
  }
  const tmp = `${target}.tmp`;
  const writer = dryRun ? null : _fs.createWriteStream(tmp);
  // Taken at creation: an async open/write failure (EACCES, a directory at the .tmp
  // path) rejects here instead of escaping unhandled, and the destroy unblocks the read.
  const writerDone = writer ? finished(writer) : null;
  // A handler from the start: the rejection is awaited later, but an error mid-read
  // would otherwise sit unhandled and take the process down before the await runs.
  if (writerDone) writerDone.catch(() => {});
  let source = null;
  if (writer) writer.once("error", () => source?.destroy());
  let changed = false;
  let after = 0;
  try {
    source = _fs.createReadStream(file);
    const stream = gz ? source.pipe(createGunzip()) : source;
    // One listener per pause: a single filter.push can write many lines, and a
    // listener per false write piles up past MaxListeners before a drain fires.
    let paused = false;
    const filter = createLogLineFilter((buf) => {
      after += buf.length;
      if (!writer || writer.destroyed) return;
      if (!writer.write(buf) && !paused) {
        paused = true;
        stream.pause();
        writer.once("drain", () => { paused = false; stream.resume(); });
      }
    });
    for await (const chunk of stream) changed = filter.push(chunk) || changed;
    changed = filter.end() || changed;
    if (writer && !writer.destroyed) writer.end();
    if (writerDone) await writerDone;
  } catch (e) {
    source?.destroy();
    writer?.destroy();
    if (writerDone) await writerDone.catch(() => {});
    removeQuietly(_fs, tmp);
    return { skipped: `unreadable (${e?.code || e?.message})`, failed: true };
  }
  if (dryRun) return { before, after: changed ? after : before, changed };
  if (!changed) {
    removeQuietly(_fs, tmp);
    return { before, after: before, changed: false };
  }
  if (!(await renameWithRetry(_fs, tmp, target))) {
    removeQuietly(_fs, tmp);
    return { skipped: "the rename failed — the original is untouched", failed: true };
  }
  // Only once the plain transcript is in place: the .gz is the last copy of the
  // bytes until the rename lands.
  if (gz) removeQuietly(_fs, file);
  let afterBytes = after;
  try { afterBytes = _fs.statSync(target).size; } catch { /* stat is reporting only */ }
  return { before, after: afterBytes, changed: true };
}

function verbFor(before, after, dryRun) {
  if (after < before) return dryRun ? "would shrink" : "shrank";
  if (after > before) return dryRun ? "would grow" : "grew";
  return dryRun ? "would be unchanged" : "was unchanged";
}

export async function cmdCompact(rest, { usage, _fs = fs, now, _getConfig = getConfig } = {}) {
  const unknown = rest.find((arg) => arg.startsWith("--") && arg !== "--dry-run");
  if (unknown) { err(`swarm: unknown option ${unknown}`); err(usage); return 1; }
  const target = rest.find((arg) => !arg.startsWith("--"));
  if (!target) { err(usage); return 1; }
  const root = resolve(target);
  if (!_fs.existsSync(root)) { err(`swarm: no such path: ${root}`); return 1; }
  const dryRun = rest.includes("--dry-run");
  const files = transcriptFiles(_fs, root);
  if (!files.length) { out(`swarm: no transcripts under ${root}`); return 0; }

  const cfg = _getConfig();
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);

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
  let failed = 0;
  for (const [runDir, runFiles] of [...byRun].sort(([a], [b]) => a.localeCompare(b))) {
    const live = runLiveness(runDir, { heartbeatMs, ...(now ? { now } : {}) });
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
        if (result.failed) failed++;
        continue;
      }
      if (!result.changed) {
        err(`  ${file}: nothing to strip`);
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
  if (!compacted) {
    out(`swarm compact: nothing to strip${skipped ? `, ${skipped} skipped` : ""}`);
  } else {
    out(`swarm compact: ${compacted} transcript(s) ${verbFor(totalBefore, totalAfter, dryRun)} `
      + `${formatBytes(totalBefore)} → ${formatBytes(totalAfter)}${skipped ? `, ${skipped} skipped` : ""}`);
  }
  return failed ? 1 : 0;
}
