// Engine-checked leaf read coverage. The third mechanical guarantee, beside
// `returns` (schema.mjs) and citations (citations.mjs): proof from the leaf's OWN
// transcript that it actually Read what a task's `mustRead` declared. Zero tokens.
//
// Only the claude stream-json transcript is understood (which also covers :cloud
// models — they run through the claude CLI). Every other runner fails closed:
// parseReadCalls returns null and the caller records a total miss. Only `Read`
// tool calls count — a Bash cat/sed, a Grep, an MCP read do not (the harness
// truncates large Bash output to a 2KB preview, and only Read carries the
// offset/limit that makes paging checkable). Pure + injectable fs; mirrors
// citations.mjs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const READ_DEFAULT_LINES = 2000; // the Read tool's own default page
const MAX_ERROR_LINES = 10;             // citations.mjs cap discipline: teach, don't flood

const win32 = () => process.platform === "win32";
// resolve normalises separators to the OS sep; case-fold on win32. Read file_path
// is absolute by contract; a required path is resolved against cwd before compare.
const samePath = (a, b) => {
  const ra = resolve(a), rb = resolve(b);
  return win32() ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};

// [{ file, offset, limit }] | null. null = unsupported runner or an unparseable
// transcript (zero assistant events in non-empty text) — the caller treats null
// as a total miss, never as "read nothing, so an empty requirement is complete".
export function parseReadCalls(text, runner) {
  if (runner !== "claude") return null;
  const reads = [];
  const resultOk = new Map(); // tool_use_id -> the paired result was not an error
  let sawAssistant = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith("{")) continue; // plain output or a torn write — skip, never fatal
    let evt;
    try { evt = JSON.parse(t); } catch { continue; }
    if (evt.type === "assistant") {
      sawAssistant = true;
      for (const b of evt.message?.content || []) {
        if (b?.type === "tool_use" && b.name === "Read" && b.input?.file_path) {
          // offset 0 normalises to 1, same as a missing offset.
          reads.push({ id: b.id, file: b.input.file_path, offset: Math.max(1, b.input.offset ?? 1), limit: b.input.limit ?? READ_DEFAULT_LINES });
        }
      }
    } else if (evt.type === "user") {
      for (const b of evt.message?.content || []) {
        if (b?.type === "tool_result" && b.tool_use_id !== undefined) resultOk.set(b.tool_use_id, b.is_error !== true);
      }
    }
  }
  if (!sawAssistant) return null;
  // An errored Read (token-cap refusal, missing file) read NOTHING — counting it
  // is the silent pass this checker exists to prevent. A Read with no paired
  // result (leaf cut mid-call) does not count either.
  return reads.filter((r) => resultOk.get(r.id) === true).map(({ file, offset, limit }) => ({ file, offset, limit }));
}

// { required: [{ path, ranges, whole }], missed: [strings], errors: [teaching lines] }
// A string/`{path}` without `lines` is a WHOLE-file entry: the engine reads the
// file to count lines and requires [[1, n]] (an empty file requires nothing).
// A `{path, lines}` requires exactly those ranges. A `{index}` reads the JSON at
// check time and expands its entries (or the `lane`th subset) — one level only.
export function resolveMustRead(entries, { cwd, substitute = (s) => s, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const required = [];
  const missed = [];
  const errors = [];
  const resolvePath = (p) => (isAbsoluteish(p) ? p : resolve(cwd || ".", p));

  const addFileEntry = (rawPath, lines) => {
    const sub = applySubstitute(rawPath, substitute, errors);
    if (sub === null) return;
    const path = resolvePath(sub);
    if (Array.isArray(lines)) {
      required.push({ path, ranges: normaliseRanges(lines), whole: false });
      return;
    }
    let n;
    try {
      const content = readFile(path);
      n = countLines(content);
    } catch (e) {
      const code = e.code || e.message;
      errors.push(`${path}: could not be read (${code}) — check the path`);
      missed.push(`${path} (unreadable: ${code})`);
      return;
    }
    if (n === 0) return; // empty file requires nothing
    required.push({ path, ranges: [[1, n]], whole: true });
  };

  const expandIndex = (rawPath, lane, depth) => {
    const sub = applySubstitute(rawPath, substitute, errors);
    if (sub === null) return;
    const path = resolvePath(sub);
    let doc;
    try {
      doc = JSON.parse(readFile(path));
    } catch (e) {
      const code = e.code || e.message;
      errors.push(`index ${path}: could not be read (${code}) — check the path`);
      missed.push(`${path} (unreadable: ${code})`);
      return;
    }
    let subset = Array.isArray(doc.entries) ? doc.entries : [];
    if (lane !== undefined) {
      const lanes = Array.isArray(doc.lanes) ? doc.lanes : [];
      if (!Array.isArray(lanes[lane])) {
        errors.push(`index ${path}: lane ${lane} is out of range (${lanes.length} lane(s))`);
        missed.push(`${path} (lane ${lane} out of range)`);
        return;
      }
      subset = lanes[lane].map((i) => doc.entries[i]);
    }
    for (const e of subset) {
      if (e && typeof e === "object" && !Array.isArray(e) && e.index !== undefined) {
        errors.push(`index ${path}: entry '${e.index}' nests another index — an index may not nest an index`);
        missed.push(`${e.index} (nested index)`);
        continue;
      }
      handleEntry(e, depth + 1);
    }
  };

  function handleEntry(entry, depth = 0) {
    if (typeof entry === "string") { addFileEntry(entry, undefined); return; }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.index !== undefined) { expandIndex(entry.index, entry.lane, depth); return; }
      if (entry.path !== undefined) { addFileEntry(entry.path, entry.lines); return; }
    }
    errors.push(`mustRead entry is neither a string nor a {path}/{index} object: ${JSON.stringify(entry)}`);
  }

  for (const entry of entries || []) handleEntry(entry, 0);
  return { required, missed, errors };
}

// { status, required (count), read, missed (strings), gaps ([{path, ranges}]) }.
// Per required path the Read windows for that path are merged into an interval
// union (adjacent windows join: a window ending at n and one starting at n+1),
// then each required range must sit inside one merged interval.
export function checkCoverage(required, reads) {
  const missed = [];
  const gaps = [];
  let read = 0;
  for (const item of required) {
    const windows = (reads || [])
      .filter((r) => samePath(r.file, item.path))
      .map((r) => [r.offset, r.offset + r.limit - 1]);
    const merged = mergeIntervals(windows);
    const uncovered = [];
    for (const [a, b] of item.ranges) uncovered.push(...subtract([a, b], merged));
    if (uncovered.length === 0) { read++; continue; }
    // Bare "<path>" ONLY when nothing of the file was read (whole-file entry);
    // otherwise per uncovered range, so the gap is legible and paging-checkable.
    if (item.whole && windows.length === 0) {
      missed.push(item.path);
    } else {
      for (const [a, b] of uncovered) missed.push(`${item.path}:${a}-${b}`);
    }
    gaps.push({ path: item.path, ranges: uncovered });
  }
  return { status: missed.length ? "incomplete" : "complete", required: required.length, read, missed, gaps };
}

// resolve + check + merge into the final coverage stamp the result carries.
// reads === null (unsupported runner / unparseable) → every entry missed.
export function computeCoverage(entries, reads, opts) {
  const { required, missed: resolveMissed, errors } = resolveMustRead(entries, opts);
  const total = required.length + resolveMissed.length;
  if (reads === null) {
    const rendered = required.map((r) => r.path).concat(resolveMissed);
    return {
      status: "unparseable", required: total, read: 0, missed: rendered,
      gaps: required.map((r) => ({ path: r.path, ranges: r.ranges })), errors,
    };
  }
  const cov = checkCoverage(required, reads);
  const missed = [...cov.missed, ...resolveMissed];
  return {
    status: missed.length ? "incomplete" : "complete",
    required: total, read: cov.read, missed, gaps: cov.gaps, errors,
  };
}

// Retry teaching: one "- <path> lines a-b: Read offset a limit n" per uncovered
// range, a range over 2000 lines split into consecutive 2000-line reads, plus any
// resolve/index errors. Capped like citations.
export function coverageErrorLines(gaps, { indexErrors = [] } = {}) {
  const lines = [];
  for (const { path, ranges } of gaps) {
    for (const [a, b] of ranges) {
      for (let s = a; s <= b; s += READ_DEFAULT_LINES) {
        const e = Math.min(s + READ_DEFAULT_LINES - 1, b);
        lines.push(`${path} lines ${s}-${e}: Read offset ${s} limit ${e - s + 1}`);
      }
    }
  }
  for (const e of indexErrors) lines.push(e);
  if (lines.length > MAX_ERROR_LINES) return [...lines.slice(0, MAX_ERROR_LINES), `…and ${lines.length - MAX_ERROR_LINES} more`];
  return lines;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{(result|resultPath):([^}]*)\}\}/g;
// Only {{resultPath:<id>}} is honoured in a mustRead path/index (Decision 6);
// {{result:}} or anything else is an authoring error, recorded and the entry dropped.
function applySubstitute(rawPath, substitute, errors) {
  if (typeof rawPath !== "string" || !rawPath) {
    errors.push(`mustRead path must be a non-empty string (got ${JSON.stringify(rawPath)})`);
    return null;
  }
  let bad = null;
  for (const m of rawPath.matchAll(TEMPLATE_RE)) if (m[1] !== "resultPath") bad = m[0];
  if (bad) {
    errors.push(`only {{resultPath:<id>}} is substituted in mustRead — '${bad}' is not honoured`);
    return null;
  }
  return substitute(rawPath);
}

// win32 absolute (C:\ or C:/) or POSIX absolute (/…). resolve() would otherwise
// glue a drive-letter path onto cwd.
function isAbsoluteish(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
}

function countLines(content) {
  const lines = String(content).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function normaliseRanges(pairs) {
  return (pairs || []).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

export function mergeIntervals(windows) {
  if (!windows.length) return [];
  const sorted = [...windows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1];
    const [s, e] = sorted[i];
    if (s <= cur[1] + 1) cur[1] = Math.max(cur[1], e); // adjacent (n, n+1) joins
    else out.push([s, e]);
  }
  return out;
}

// [a,b] minus a set of merged (sorted, disjoint) intervals → the uncovered sub-ranges.
function subtract([a, b], merged) {
  const gaps = [];
  let cursor = a;
  for (const [s, e] of merged) {
    if (e < cursor) continue;
    if (s > b) break;
    if (s > cursor) gaps.push([cursor, Math.min(s - 1, b)]);
    cursor = Math.max(cursor, e + 1);
    if (cursor > b) break;
  }
  if (cursor <= b) gaps.push([cursor, b]);
  return gaps;
}
