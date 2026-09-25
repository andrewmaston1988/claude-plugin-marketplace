// Proof from a leaf's own transcript that it Read what `mustRead` declared.
// Two runners are understood — claude stream-json (`Read` tool calls) and codex
// (shell commands in exec events); any other runner fails closed (null → total miss).
// Only real reads count: Claude's Bash output is truncated to a preview, and codex's
// searches are not reads, so neither is mistaken for the file itself.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const READ_DEFAULT_LINES = 2000; // the Read tool's own default page
// The runners whose transcript this module parses. The one list: manifest validation
// refuses a mustRead task on any other, so a check can never silently pass.
export const TRANSCRIPT_RUNNERS = new Set(["claude", "codex"]);
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
// `cwd` is the leaf's own, for a codex command that names a relative path.
export function parseReadCalls(text, runner, { cwd } = {}) {
  if (runner === "codex") return parseCodexReadCalls(text, cwd);
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

// ── codex ─────────────────────────────────────────────────────────────────────
// Codex has no Read tool: a leaf reads with a shell command, and the transcript
// records it as an item.completed / command_execution event carrying `command`,
// `exit_code` and `aggregated_output`. The same [{file, offset, limit}] windows
// come out, so checkCoverage and everything downstream stay shared.

// Codex middle-truncates a command's output before the MODEL sees it, so
// `aggregated_output` (the event field) is not what the model read: inside this
// budget it arrived whole, past it only as the first and last halves.
// https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/core/src/tools/events.rs:390
const CODEX_MODEL_OUTPUT_BYTES = 40_000;
const CODEX_SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh"]);

function parseCodexReadCalls(text, cwd) {
  const reads = [];
  let sawStart = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith("{")) continue; // "Reading additional input from stdin...", or a torn write
    let evt;
    try { evt = JSON.parse(t); } catch { continue; }
    if (evt.type === "thread.started" || evt.type === "turn.started") { sawStart = true; continue; }
    // An item.started twin carries exit_code null; only a completed, exit-0 command
    // ran — the codex analogue of "an errored Read read nothing".
    if (evt.type !== "item.completed") continue;
    const item = evt.item;
    if (item?.type !== "command_execution" || item.exit_code !== 0) continue;
    const payload = codexShellPayload(String(item.command || ""));
    if (!payload) continue;
    const specs = [];
    // A pipe or an output redirect means the model saw another program's output or a
    // file's, never this one's. `2>&1` merges streams and is neither, so it is stripped
    // BEFORE the chain split — the `&` inside it would otherwise cut the command in two.
    for (const pipeline of codexPipelines(payload.replace(/\d*>&\d+/g, ""))) {
      if (pipeline.includes("|") || pipeline.includes(">")) continue;
      const spec = codexReadSpec(pipeline);
      if (spec) specs.push(spec);
    }
    if (!specs.length) continue;
    const output = String(item.aggregated_output ?? "");
    // One command's output is shared by every segment, so the cap rules on the
    // command: past it, only a lone read's bytes can be told apart.
    if (specs.length > 1 && Buffer.byteLength(output, "utf8") > CODEX_MODEL_OUTPUT_BYTES) continue;
    for (const spec of specs) {
      for (const w of codexWindows(output, spec)) {
        reads.push({ file: codexPath(spec.path, cwd), offset: w.offset, limit: w.limit });
      }
    }
  }
  return sawStart ? reads : null;
}

// `"C:\WINDOWS\system32\cmd.exe" /c "<payload>"` → `<payload>`; null when the
// command is not a shell wrapper. Matched on the exe BASENAME after stripping its
// quotes: a literal `cmd.exe /c` substring occurs in 0 of the 49 commands in the
// real transcript, and the wrapper path arrives with doubled separators.
function codexShellPayload(command) {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s+(\/c|-c|-lc|-command)\s+([\s\S]*)$/i.exec(command);
  if (!m) return null;
  const exe = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\.(exe|cmd|bat|com)$/i, "").split(/[\\/]/).pop().toLowerCase();
  if (!CODEX_SHELLS.has(exe)) return null;
  const payload = m[5].trim();
  const q = payload[0];
  return payload ? (q === '"' || q === "'") && payload.length > 1 && payload.endsWith(q) ? payload.slice(1, -1) : payload : null;
}

// cmd chains with & / &&, POSIX with `;`. Quote-aware so a path containing & survives.
function codexPipelines(payload) {
  const out = [];
  let cur = "", quote = null;
  for (const ch of payload) {
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "&" || ch === ";") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const codexTokens = (pipeline) => pipeline.match(/"[^"]*"|'[^']*'|\S+/g) || [];
const unquote = (s) => String(s ?? "").replace(/["']/g, "");

// The read allowlist; everything else — findstr, rg, grep, dir, pytest — is not a
// read, exactly as Grep is not a Read for claude. Fails closed: an unrecognised
// shape is an honest `incomplete` with teaching, never a false `complete`.
function codexReadSpec(pipeline) {
  const toks = codexTokens(pipeline);
  if (toks.length < 2) return null;
  const cmd = unquote(toks[0]).split(/[\\/]/).pop().toLowerCase();
  const rest = toks.slice(1).map(unquote);
  const firstPath = (...skip) => rest.find((t, i) => !skip.includes(i) && !t.startsWith("-"));
  if (cmd === "sed") {                                  // sed -n '<a>,<b>p' <path>
    const i = rest.indexOf("-n");
    const m = /^(\d+),(\d+)p$/.exec(rest[i + 1] ?? "");
    if (i === -1 || !m || !firstPath(i + 1)) return null;
    return { path: firstPath(i + 1), a: Number(m[1]), b: Number(m[2]) };
  }
  if (cmd === "head") {                                 // head -n <n> <path>
    const i = rest.indexOf("-n");
    const n = Number(rest[i + 1]);
    if (i === -1 || !Number.isInteger(n) || n < 1 || !firstPath(i + 1)) return null;
    return { path: firstPath(i + 1), a: 1, b: n };
  }
  if (cmd === "get-content") {
    const i = rest.findIndex((t) => /^-totalcount$/i.test(t)); // Get-Content <path> -TotalCount <n>
    if (i !== -1) {
      const n = Number(rest[i + 1]);
      const path = firstPath(i, i + 1);
      return Number.isInteger(n) && n >= 1 && path ? { path, a: 1, b: n } : null;
    }
    // -Head/-Tail/-First/-Last page too, and a window this parser does not read is not a read.
    if (rest.some((t) => /^-(head|tail|first|last)$/i.test(t))) return null;
  } else if (cmd !== "type" && cmd !== "cat") return null;
  const path = firstPath();
  return path ? { path, a: 1, b: Infinity } : null;
}

// The parsed command carries doubled separators (`C:\\Users\\…`) and a quoted
// wrapper peels to `\"C:\…\"`; cmd tolerates both, a path compare does not.
function codexPath(raw, cwd) {
  const cleaned = unquote(raw).replace(/\\{2,}/g, "\\").replace(/^\\+(?=[A-Za-z]:)/, "");
  return isAbsoluteish(cleaned) ? cleaned : resolve(cwd || ".", cleaned);
}

// What the model actually saw of one command's output: all of it inside the cap;
// past it, the head and tail halves only, so just the lines ending inside each half
// are proven read (a line cut by the boundary is not).
function codexWindows(output, spec) {
  const whole = spec.b === Infinity;
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= CODEX_MODEL_OUTPUT_BYTES) {
    return [{ offset: spec.a, limit: whole ? Infinity : spec.b - spec.a + 1 }];
  }
  const half = CODEX_MODEL_OUTPUT_BYTES / 2;
  const count = (s) => (s.match(/\n/g) || []).length;
  const head = count(bytes.subarray(0, half).toString("utf8"));
  const tail = Math.max(0, count(bytes.subarray(bytes.length - half).toString("utf8")) - 1);
  const end = whole ? countLines(output) : spec.b;
  const windows = [];
  if (head > 0) windows.push({ offset: spec.a, limit: head });
  if (tail > 0) windows.push({ offset: end - tail + 1, limit: tail });
  return windows;
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
export function coverageErrorLines(gaps, { indexErrors = [], runner = "claude" } = {}) {
  const lines = [];
  for (const { path, ranges } of gaps) {
    for (const [a, b] of ranges) {
      if (runner === "codex") {
        // The read allowlist, so the re-ask names a command the parser counts. Not
        // split at 2000 lines like Claude's: codex's cap is BYTES, and a line split
        // buys no guarantee the window fits it.
        lines.push(`${path} lines ${a}-${b}: sed -n '${a},${b}p' "${path}"`);
        continue;
      }
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

// The whole re-ask paragraph in one place. The sentence has to name the leaf's
// OWN reader: a codex leaf has no Read tool.
export function coverageRetryBlock(gaps, { indexErrors = [], runner = "claude" } = {}) {
  const how = runner === "codex"
    ? "Run the command shown for each of the following, exactly as stated"
    : "Read each of the following with the Read tool, exactly as stated";
  return `You did not read everything this task requires. ${how}, then give your corrected answer:` +
    `\n  - ${coverageErrorLines(gaps, { indexErrors, runner }).join("\n  - ")}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

// The one definition of a result template; manifest.mjs and scheduler.mjs import it.
export const TEMPLATE_RE = /\{\{(result|resultPath):([^}]*)\}\}/g;
// Only {{resultPath:<id>}} is honoured in a mustRead path/index;
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
