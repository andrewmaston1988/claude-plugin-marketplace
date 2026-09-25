// Codex leaves read with shell commands, not the Read tool, so their mustRead
// coverage comes from the exec events in their own transcript. Sibling of
// coverage.test.mjs, which is over the 500-line bar and may not grow.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReadCalls, computeCoverage } from "../src/coverage.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "swarm-codex-cov-")); }
const writeLines = (dir, name, n) => { const p = join(dir, name); writeFileSync(p, "x\n".repeat(n)); return p; };

// ── fixtures: the REAL wrapper shape ──────────────────────────────────────────
// A parsed command carries a quoted absolute exe path with DOUBLED separators
// (`C:\\Users\\…` — cmd tolerates them). Build that by doubling a real path rather
// than hand-escaping it per case.
let _uid = 0;
const dbl = (p) => p.replace(/\\/g, "\\\\");
const cmdRun = (payload) => `"${dbl("C:\\WINDOWS\\system32\\cmd.exe")}" /c "${payload}"`;
const bashRun = (payload) => `"${dbl("C:\\Program Files\\Git\\usr\\bin\\bash.exe")}" -c '${payload}'`;

// Every completed exec event in the real transcript has an `item.started` twin
// (exit_code null) and a non-JSON line ahead of the stream.
function event(command, { exit = 0, output = "", started = true } = {}) {
  const item = { id: `item_${_uid++}`, type: "command_execution", command, aggregated_output: output, exit_code: exit, status: exit === 0 ? "completed" : "failed" };
  const lines = [];
  if (started) lines.push(JSON.stringify({ type: "item.started", item: { ...item, aggregated_output: "", exit_code: null, status: "in_progress" } }));
  lines.push(JSON.stringify({ type: "item.completed", item }));
  return lines;
}
const transcript = (...events) => [
  "Reading additional input from stdin...",
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "turn.started" }),
  ...events.flat(),
].join("\n") + "\n";
const readsOf = (text, cwd) => parseReadCalls(text, "codex", { cwd });

// ── 1. whole file ─────────────────────────────────────────────────────────────

test("codex: a quoted-exe cmd wrapper `type <abs>` at exit 0 covers a whole-file mustRead; bash -c `cat` likewise", () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const reads = readsOf(transcript(event(cmdRun(`type ${dbl(F)}`), { output: "x\nx\nx\n" })), dir);
    deepEqual(reads, [{ file: F, offset: 1, limit: Infinity }]);
    equal(computeCoverage([F], reads, { cwd: dir }).status, "complete");
    // the bash wrapper: the same read through `-c` (not `-lc`)
    const bash = readsOf(transcript(event(bashRun(`cat ${dbl(F)}`), { output: "x\nx\nx\n" })), dir);
    deepEqual(bash, [{ file: F, offset: 1, limit: Infinity }]);
    equal(computeCoverage([F], bash, { cwd: dir }).status, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 2. chained ────────────────────────────────────────────────────────────────

test("codex: `type A & type B` in one payload covers both files", () => {
  const dir = tmp();
  try {
    const A = writeLines(dir, "a.mjs", 2);
    const B = writeLines(dir, "b.mjs", 4);
    const reads = readsOf(transcript(event(cmdRun(`type ${dbl(A)} & type ${dbl(B)}`), { output: "x\nx\nx\nx\nx\nx\n" })), dir);
    deepEqual(reads, [
      { file: A, offset: 1, limit: Infinity },
      { file: B, offset: 1, limit: Infinity },
    ]);
    equal(computeCoverage([A, B], reads, { cwd: dir }).status, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 3. failed ─────────────────────────────────────────────────────────────────

test("codex: exit code != 0 covers nothing; the item.started twin (exit_code null) covers nothing", () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const failed = readsOf(transcript(event(cmdRun(`type ${dbl(F)}`), { exit: 1, output: "x\nx\nx\n" })), dir);
    deepEqual(failed, []);
    // A chain's exit_code is only the LAST segment's status (cmd `&`), so an earlier
    // failure rides on an exit 0 — accepted: a false credit needs the failing path to
    // equal a mustRead path, and resolveMustRead already requires that file to exist.
    const A = writeLines(dir, "a.mjs", 2);
    const chain = readsOf(transcript(event(cmdRun(`type ${dbl(A)} & type ${dbl(F)}`), { output: "x\nx\nx\nx\nx\n" })), dir);
    deepEqual(chain.map((r) => r.file), [A, F]);
    // started only: no completed event at all
    const startedOnly = transcript([JSON.stringify({ type: "item.started", item: { type: "command_execution", command: cmdRun(`type ${dbl(F)}`), aggregated_output: "", exit_code: null, status: "in_progress" } })]);
    deepEqual(readsOf(startedOnly, dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 4. not reads ──────────────────────────────────────────────────────────────

test("codex: findstr / rg cover nothing, and neither does a piped dump (the pipe check runs on the UNSPLIT pipeline)", () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const findstr = readsOf(transcript(event(cmdRun(`findstr /n /c:"x" ${dbl(F)}`), { output: "1:x\n" })), dir);
    deepEqual(findstr, []);
    const rg = readsOf(transcript(event(cmdRun(`rg -n x ${dbl(F)}`), { output: "1:x\n" })), dir);
    deepEqual(rg, []);
    // the model saw findstr's output, not the file
    const piped = readsOf(transcript(event(cmdRun(`type ${dbl(F)} | findstr x`), { output: "x\n" })), dir);
    deepEqual(piped, []);
    // a piped segment does not poison its siblings
    const mixed = readsOf(transcript(event(cmdRun(`type ${dbl(F)} & rg -n x ${dbl(F)} | findstr y`), { output: "x\n" })), dir);
    deepEqual(mixed.map((r) => r.file), [F]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 5. ranges ─────────────────────────────────────────────────────────────────

test("codex: `sed -n '10,40p'` covers 10-40 only; `Get-Content -TotalCount 20` covers 1-20", () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 50);
    const sed = readsOf(transcript(event(bashRun(`sed -n '10,40p' "${dbl(F)}"`), { output: "x\n".repeat(31) })), dir);
    deepEqual(sed, [{ file: F, offset: 10, limit: 31 }]);
    const cov = computeCoverage([{ path: F, lines: [[1, 50]] }], sed, { cwd: dir });
    equal(cov.status, "incomplete");
    deepEqual(cov.gaps, [{ path: F, ranges: [[1, 9], [41, 50]] }]);

    const gc = readsOf(transcript(event(cmdRun(`Get-Content "${dbl(F)}" -TotalCount 20`), { output: "x\n".repeat(20) })), dir);
    deepEqual(gc, [{ file: F, offset: 1, limit: 20 }]);
    equal(computeCoverage([{ path: F, lines: [[1, 20]] }], gc, { cwd: dir }).status, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 6. paths ──────────────────────────────────────────────────────────────────

test("codex: a relative path resolves against the task cwd; a doubled-separator absolute matches the single-separator mustRead entry", () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const rel = readsOf(transcript(event(cmdRun("type f.mjs"), { output: "x\nx\nx\n" })), dir);
    deepEqual(rel, [{ file: F, offset: 1, limit: Infinity }]);
    equal(computeCoverage([F], rel, { cwd: dir }).status, "complete");
    const abs = readsOf(transcript(event(cmdRun(`type ${dbl(F)}`), { output: "x\nx\nx\n" })), dir);
    deepEqual(abs, [{ file: F, offset: 1, limit: Infinity }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 7. truncation ─────────────────────────────────────────────────────────────

test("codex: a whole-file dump past the model-visible cap covers head + tail only, never the whole file", () => {
  const dir = tmp();
  try {
    const N = 3000;
    const LINE = "x".repeat(30) + "\n"; // 31 bytes: N lines is ~93,000 bytes, past the cap
    const content = LINE.repeat(N);
    const F = join(dir, "big.mjs");
    writeFileSync(F, content);
    const reads = readsOf(transcript(event(cmdRun(`type ${dbl(F)}`), { output: content })), dir);
    equal(reads.length, 2, "a truncated dump is two windows, not one");
    const coverage = computeCoverage([F], reads, { cwd: dir });
    equal(coverage.status, "incomplete");
    // source literals: head and tail are each half the ~40,000-byte budget, and a
    // cut mid-line leaves that line PARTIAL — visible lines are the complete ones
    const HALF = 20000;
    const headLines = (content.slice(0, HALF).match(/\n/g) || []).length;
    const tailLines = (content.slice(-HALF).match(/\n/g) || []).length - 1;
    equal(reads[0].limit, headLines);
    equal(reads[1].offset, N - tailLines + 1);
    deepEqual(coverage.gaps, [{ path: F, ranges: [[headLines + 1, N - tailLines]] }]);
    // just inside the cap: the same dump is one whole-file window
    const small = writeLines(dir, "small.mjs", 100);
    const inside = readsOf(transcript(event(cmdRun(`type ${dbl(small)}`), { output: "x\n".repeat(100) })), dir);
    deepEqual(inside, [{ file: small, offset: 1, limit: Infinity }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 8. unparseable ────────────────────────────────────────────────────────────

test("codex: an empty or torn transcript (no thread.started / turn.started) → null, the fail-closed contract", () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    equal(readsOf("", dir), null);
    equal(readsOf("Reading additional input from stdin...\n", dir), null);
    equal(readsOf('{"type":"item.completed","item":{"type":"command_execution","command":"x"}}\n', dir), null);
    equal(readsOf('{"type":"turn.star', dir), null);
    // a start event with nothing after it is parseable and reads nothing
    deepEqual(readsOf(JSON.stringify({ type: "turn.started" }) + "\n", dir), []);
    equal(computeCoverage([F], readsOf("", dir), { cwd: dir }).status, "unparseable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
