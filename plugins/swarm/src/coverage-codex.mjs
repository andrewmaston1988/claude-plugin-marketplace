// What a codex leaf can actually be shown: the cap on the output the model sees, the page
// arithmetic that keeps a required range inside it, and the read plan a leaf is handed up
// front. The transcript parser lives in coverage.mjs; this is the arithmetic the launch-time
// plan and the check-time requirement share, so the two can never disagree about a page.

import { readFileSync } from "node:fs";

// Codex middle-truncates a command's output before the MODEL sees it, so
// `aggregated_output` (the event field) is not what the model read: inside this
// budget it arrived whole, past it only as the first and last halves.
// rust-v0.156.1: codex-rs/models-manager/models.json sets truncation_policy tokens limit 10000; codex-rs/utils/string/src/truncate.rs uses APPROX_BYTES_PER_TOKEN = 4.
export const CODEX_MODEL_OUTPUT_BYTES = 40_000;

// The ONE windowed read. On win32 the codex sandbox kills every MSYS2 program, so it is
// PowerShell's; `@( )` stops a one-line file indexing characters instead of lines, and
// single quotes keep `$` and backticks in a path literal.
export function codexWindowedRead(path, a, b, platform = process.platform) {
  return platform === "win32"
    ? `@(Get-Content -LiteralPath '${path.replace(/'/g, "''")}')[${a - 1}..${b - 1}]`
    : `sed -n '${a},${b}p' "${path}"`;
}

// Per-line EMITTED bytes — the line's own bytes plus the EOL the reader puts back on it.
// On win32 the read is PowerShell's, which emits CRLF, so a range sized in SOURCE bytes can
// arrive PAST the cap and be truncated to head+tail (page.html 1-416 = 40,000 source bytes,
// 40,416 emitted). [] when the file cannot be read: nothing is then known to be over cap.
function codexLineSizes(path, platform) {
  const eol = platform === "win32" ? 1 : 0;
  try {
    return (readFileSync(path, "utf8").match(/[^\n]*\n|[^\n]+$/g) || [])
      .map((line) => Buffer.byteLength(line, "utf8") + eol);
  } catch {
    return [];
  }
}

// A required range, split into pages that each fit the model-visible budget.
function codexRanges(path, start, end, platform = process.platform) {
  const sizes = codexLineSizes(path, platform);
  const eol = platform === "win32" ? 1 : 0;
  const ranges = [];
  let first = start, bytes = 0;
  for (let line = start; line <= end; line++) {
    const size = sizes[line - 1] ?? eol;
    if (bytes && bytes + size > CODEX_MODEL_OUTPUT_BYTES) {
      ranges.push([first, line - 1]);
      first = line;
      bytes = 0;
    }
    bytes += size;
  }
  if (first <= end) ranges.push([first, end]);
  return ranges;
}

// One line per page of one required range: the path, its line span, and the exact command
// that reads it. The ONE mapper — the launch-time read plan and the retry teaching may not
// drift apart.
export function codexRangeLines(path, a, b, platform = process.platform) {
  return codexRanges(path, a, b, platform)
    .map(([start, end]) => `${path} lines ${start}-${end}: ${codexWindowedRead(path, start, end, platform)}`);
}

// A required line over the cap can never be shown whole by ANY codex command, so it is not
// something the leaf failed to do: it leaves the requirement and is reported as uncoverable.
// An item left with no coverable line is dropped entirely — a requirement nothing can
// satisfy would otherwise sit in `required` forever, uncovered and unread.
export function codexCoverable(required, { platform = process.platform } = {}) {
  const coverable = [];
  const uncoverable = [];
  for (const item of required || []) {
    const sizes = codexLineSizes(item.path, platform);
    const kept = [];
    const excluded = [];
    for (const [a, b] of item.ranges) {
      let keep = null, drop = null; // the runs being collected; a range boundary ends both
      for (let line = a; line <= b; line++) {
        const size = sizes[line - 1];
        if (size !== undefined && size > CODEX_MODEL_OUTPUT_BYTES) {
          if (keep !== null) { kept.push([keep, line - 1]); keep = null; }
          if (drop === null) drop = line;
        } else {
          if (drop !== null) { excluded.push([drop, line - 1]); drop = null; }
          if (keep === null) keep = line;
        }
      }
      if (keep !== null) kept.push([keep, b]);
      if (drop !== null) excluded.push([drop, b]);
    }
    if (!kept.length) { uncoverable.push({ path: item.path, ranges: item.ranges }); continue; }
    if (excluded.length) uncoverable.push({ path: item.path, ranges: excluded });
    coverable.push({ ...item, ranges: kept });
  }
  return { required: coverable, uncoverable };
}

// The whole read plan: every page of every required range, uncapped. Capping is the retry's
// job (coverageErrorLines); a leaf handed its list up front gets all of it.
export function codexReadPlan(required, { platform = process.platform } = {}) {
  const lines = [];
  for (const { path, ranges } of required || []) {
    for (const [a, b] of ranges) lines.push(...codexRangeLines(path, a, b, platform));
  }
  return lines;
}

// The read plan as files a leaf can see whole: past the cap codex shows the model only the
// first and last halves, so each part is sized in the bytes a reader EMITS for it (the
// source bytes plus the CRLF PowerShell puts back), never the raw file size. A single line
// over the cap cannot be split further and rides alone — codexCoverable is what keeps those
// out of a plan.
export function splitReadPlan(lines) {
  const parts = [];
  let part = [];
  let bytes = 0;
  for (const line of lines || []) {
    const size = Buffer.byteLength(line, "utf8") + 2;
    if (part.length && bytes + size > CODEX_MODEL_OUTPUT_BYTES) { parts.push(part); part = []; bytes = 0; }
    part.push(line);
    bytes += size;
  }
  if (part.length) parts.push(part);
  return parts;
}
