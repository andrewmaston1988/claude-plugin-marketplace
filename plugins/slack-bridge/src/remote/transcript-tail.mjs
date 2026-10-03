// Reads a session transcript's assistant text after a cursor, and owns the
// mirror cursor + its lock. Overlapping hook invocations (PostToolUse fires per
// tool call) must neither double-send nor move the cursor backwards. The cursor
// carries a byte offset so each hook reads only what was appended since the last.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, statSync, unlinkSync, fstatSync, readSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;

// Complete lines from byte `offset` on, plus the offset just past the last one:
// a half-written last line is left for the next read. Null when `offset` is no
// longer a line boundary — the transcript was truncated or rewritten.
export function readTranscriptFrom(path, offset = 0) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset > size) return null;
    const start = Math.max(offset - 1, 0);
    const buf = Buffer.alloc(size - start);
    for (let got = 0; got < buf.length;) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    if (offset > 0 && buf[0] !== 0x0a) return null;
    const body = offset > 0 ? buf.subarray(1) : buf;
    const complete = body.subarray(0, body.lastIndexOf(0x0a) + 1);
    const entries = [];
    for (const line of complete.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* not a JSON line */ }
    }
    return { entries, end: offset + complete.length };
  } finally {
    closeSync(fd);
  }
}

function assistantText(entries) {
  const texts = [];
  for (const e of entries) {
    if (e.type !== "assistant" || e.isSidechain) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "text" && b.text?.trim()) texts.push(b.text.trim());
  }
  return texts.join("\n\n");
}

// An offset read holds only entries after the cursor, so all of it counts.
export function textOf(entries, cursorUuid) {
  const lastUuid = entries.filter((e) => typeof e.uuid === "string").at(-1)?.uuid ?? cursorUuid ?? null;
  return { text: assistantText(entries), lastUuid };
}

// Assistant `text` blocks after the cursor entry, joined. Tool calls, thinking
// and user turns are skipped. No cursor, or one no longer in the transcript,
// starts fresh at the newest entry — no backfill.
export function textAfter(entries, cursorUuid) {
  const withUuid = entries.filter((e) => typeof e.uuid === "string");
  const lastUuid = withUuid.at(-1)?.uuid ?? cursorUuid ?? null;
  const idx = cursorUuid ? withUuid.findIndex((e) => e.uuid === cursorUuid) : -1;
  if (idx === -1) return { text: "", lastUuid };
  return { text: assistantText(withUuid.slice(idx + 1)), lastUuid };
}

export function readCursor(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function writeCursor(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

// Returns a release function, or null when another invocation holds a fresh lock.
export function tryLock(lockFile, { _now = () => Date.now() } = {}) {
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockFile, "wx"));
      return () => { try { unlinkSync(lockFile); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let mtime;
      try { mtime = statSync(lockFile).mtimeMs; } catch { continue; } // released between open and stat
      if (_now() - mtime <= LOCK_STALE_MS) return null;
      try { unlinkSync(lockFile); } catch {}
    }
  }
  return null;
}
