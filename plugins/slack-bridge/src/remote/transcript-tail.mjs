// Reads a session transcript's assistant text after a cursor, and owns the
// mirror cursor + its lock. Overlapping hook invocations (PostToolUse fires per
// tool call) must neither double-send nor move the cursor backwards.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;

export function readTranscript(path, _readFile = readFileSync) {
  const entries = [];
  for (const line of _readFile(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a half-written last line */ }
  }
  return entries;
}

// Assistant `text` blocks after the cursor entry, joined. Tool calls, thinking
// and user turns are skipped. No cursor, or one no longer in the transcript,
// starts fresh at the newest entry — no backfill.
export function textAfter(entries, cursorUuid) {
  const withUuid = entries.filter((e) => typeof e.uuid === "string");
  const lastUuid = withUuid.at(-1)?.uuid ?? cursorUuid ?? null;
  const idx = cursorUuid ? withUuid.findIndex((e) => e.uuid === cursorUuid) : -1;
  if (idx === -1) return { text: "", lastUuid };
  const texts = [];
  for (const e of withUuid.slice(idx + 1)) {
    if (e.type !== "assistant" || e.isSidechain) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "text" && b.text?.trim()) texts.push(b.text.trim());
  }
  return { text: texts.join("\n\n"), lastUuid };
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
