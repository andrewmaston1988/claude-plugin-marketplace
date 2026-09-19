// Engine-checked leaf read coverage — all tests for src/coverage.mjs and its
// scheduler/manifest/CLI integration live in this one file (the citations.test.mjs
// precedent). RED first; every assertion compares against a source literal, never
// the constant it pins.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseReadCalls, resolveMustRead, checkCoverage, computeCoverage,
  coverageErrorLines, READ_DEFAULT_LINES, mergeIntervals,
} from "../src/coverage.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/coverage/", import.meta.url));
const fixture = (f) => readFileSync(join(FIXTURES, f), "utf8");
function tmp() { return mkdtempSync(join(tmpdir(), "swarm-cov-")); }

// A claude stream-json line for one assistant turn issuing Read tool calls, and
// the paired tool_result turn. Ids are globally unique so pairing is unambiguous.
let _uid = 0;
function readTurns(reads) {
  const withIds = reads.map((r) => ({ ...r, id: `tu${_uid++}` }));
  const asst = JSON.stringify({
    type: "assistant",
    message: {
      id: `m${_uid}`, stop_reason: "end_turn",
      content: withIds.map((r) => ({
        type: "tool_use", id: r.id, name: r.tool || "Read",
        input: r.tool && r.tool !== "Read" ? { command: r.file } : { file_path: r.file, ...(r.offset != null && { offset: r.offset }), ...(r.limit != null && { limit: r.limit }) },
      })),
    },
  });
  const user = JSON.stringify({
    type: "user",
    message: { content: withIds.map((r) => ({ type: "tool_result", tool_use_id: r.id, is_error: r.error === true, content: "" })) },
  });
  return [asst, user];
}

// ── parseReadCalls (pure) ─────────────────────────────────────────────────────

test("parseReadCalls: collects {file,offset,limit} from assistant Read blocks; ignores Bash/Grep/user-scoped", () => {
  const text = [
    ...readTurns([{ file: "C:/a.mjs", offset: 1, limit: 100 }]),
    ...readTurns([{ file: "C:/b.mjs", tool: "Bash" }]),
    // a Read nested in a user event must NOT be collected
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "C:/c.mjs" } }] } }),
  ].join("\n");
  const reads = parseReadCalls(text, "claude");
  deepEqual(reads, [{ file: "C:/a.mjs", offset: 1, limit: 100 }]);
});

test("parseReadCalls: missing offset → 1; missing limit → 2000 (source literal)", () => {
  const [asst, user] = readTurns([{ file: "C:/a.mjs" }]);
  const reads = parseReadCalls(asst + "\n" + user, "claude");
  deepEqual(reads, [{ file: "C:/a.mjs", offset: 1, limit: 2000 }]);
  equal(READ_DEFAULT_LINES, 2000);
});

test("parseReadCalls: offset 0 normalises to 1 (Math.max(1,offset)), same as missing", () => {
  const [asst, user] = readTurns([{ file: "C:/a.mjs", offset: 0, limit: 50 }]);
  const reads = parseReadCalls(asst + "\n" + user, "claude");
  equal(reads[0].offset, 1);
});

test("parseReadCalls: a Read whose paired result is_error:true does not count; nor an unpaired Read", () => {
  const errored = readTurns([{ file: "C:/big.mjs", error: true }]);
  // an unpaired read: assistant only, no user result
  const unpaired = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "solo", name: "Read", input: { file_path: "C:/lone.mjs" } }] } });
  const reads = parseReadCalls([...errored, unpaired].join("\n"), "claude");
  deepEqual(reads, []);
});

test("parseReadCalls: non-JSON lines and a torn final line are skipped, not fatal", () => {
  const [asst, user] = readTurns([{ file: "C:/a.mjs", offset: 1, limit: 10 }]);
  const text = "plain preamble\n" + asst + "\n" + user + '\n{"type":"assist'; // torn
  const reads = parseReadCalls(text, "claude");
  equal(reads.length, 1);
});

test("parseReadCalls: runner other than claude → null", () => {
  const [asst, user] = readTurns([{ file: "C:/a.mjs" }]);
  equal(parseReadCalls(asst + "\n" + user, "codex"), null);
});

test("parseReadCalls: non-empty text with zero assistant events → null (codex-shaped item events)", () => {
  const codexish = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat file" } }),
    JSON.stringify({ type: "item.completed", item: { type: "assistant_message", text: "done" } }),
  ].join("\n");
  equal(parseReadCalls(codexish, "claude"), null);
});

test("parseReadCalls: real fixture rv-maintainability yields exactly 2 Read calls", () => {
  const reads = parseReadCalls(fixture("rv-maintainability.assistant.jsonl"), "claude");
  equal(reads.length, 2); // mutation: counting Bash as reads → 5
  ok(reads.every((r) => /preflight\.json$/i.test(r.file) || /principles_cross_cutting\.md$/i.test(r.file)));
});

// ── resolveMustRead (injected readFile) ───────────────────────────────────────

const rf = (files) => (p) => {
  const key = Object.keys(files).find((k) => k === p || k.replace(/\\/g, "/") === p.replace(/\\/g, "/"));
  if (key === undefined) { const e = new Error("no"); e.code = "ENOENT"; throw e; }
  return files[key];
};

test("resolveMustRead: string entry → [[1,n]], trailing newline not counted", () => {
  const cwd = "C:/w";
  const { required } = resolveMustRead(["a.md"], { cwd, readFile: rf({ "C:/w/a.md": "a\nb\n" }) });
  equal(required.length, 1);
  deepEqual(required[0].ranges, [[1, 2]]); // mutation: naive split("\n").length → 3
  equal(required[0].whole, true);
});

test("resolveMustRead: empty file → no required range", () => {
  const { required } = resolveMustRead(["e.md"], { cwd: "C:/w", readFile: rf({ "C:/w/e.md": "" }) });
  equal(required.length, 0);
});

test("resolveMustRead: {path, lines} → the given ranges, sorted", () => {
  const { required } = resolveMustRead([{ path: "C:/x.mjs", lines: [[1001, 1830], [1, 1000]] }], { cwd: "C:/w" });
  deepEqual(required[0].ranges, [[1, 1000], [1001, 1830]]);
  equal(required[0].whole, false);
});

test("resolveMustRead: {index} expands entries; {index, lane:1} expands only that lane", () => {
  const doc = JSON.stringify({
    entries: [{ path: "C:/one.mjs", lines: [[1, 5]] }, { path: "C:/two.mjs", lines: [[1, 5]] }, { path: "C:/three.mjs", lines: [[1, 5]] }],
    lanes: [[0], [1, 2]],
  });
  const all = resolveMustRead([{ index: "C:/i.json" }], { cwd: "C:/w", readFile: rf({ "C:/i.json": doc }) });
  equal(all.required.length, 3);
  const lane1 = resolveMustRead([{ index: "C:/i.json", lane: 1 }], { cwd: "C:/w", readFile: rf({ "C:/i.json": doc }) });
  deepEqual(lane1.required.map((r) => r.path), ["C:/two.mjs", "C:/three.mjs"]);
});

test("resolveMustRead: lane out of range → error line + missed entry", () => {
  const doc = JSON.stringify({ entries: [{ path: "C:/one.mjs", lines: [[1, 5]] }], lanes: [[0]] });
  const { missed, errors } = resolveMustRead([{ index: "C:/i.json", lane: 7 }], { cwd: "C:/w", readFile: rf({ "C:/i.json": doc }) });
  ok(errors.some((e) => /lane 7 is out of range/.test(e)));
  ok(missed.some((m) => /lane 7 out of range/.test(m)));
});

test("resolveMustRead: an index may not nest an index", () => {
  const doc = JSON.stringify({ entries: [{ index: "C:/inner.json" }] });
  const { errors, missed } = resolveMustRead([{ index: "C:/i.json" }], { cwd: "C:/w", readFile: rf({ "C:/i.json": doc }) });
  ok(errors.some((e) => /nests another index/.test(e)));
  ok(missed.some((m) => /nested index/.test(m)));
});

test("resolveMustRead: unreadable file → error line + missed '<path> (unreadable: ENOENT)' (fail closed)", () => {
  const { missed, errors } = resolveMustRead(["C:/gone.md"], { cwd: "C:/w", readFile: rf({}) });
  ok(errors.length > 0);
  ok(missed.some((m) => /gone\.md \(unreadable: ENOENT\)/.test(m))); // mutation: skip silently → missed empty
});

test("resolveMustRead: {{resultPath:x}} substituted; any other template → error", () => {
  const sub = (s) => s.replace("{{resultPath:rv-x}}", "C:/results/rv-x.json");
  const good = resolveMustRead([{ path: "{{resultPath:rv-x}}", lines: [[1, 5]] }], { cwd: "C:/w", substitute: sub });
  equal(good.required[0].path, "C:/results/rv-x.json");
  const bad = resolveMustRead([{ path: "{{result:rv-x}}", lines: [[1, 5]] }], { cwd: "C:/w", substitute: sub });
  ok(bad.errors.some((e) => /only \{\{resultPath:<id>\}\} is substituted/.test(e)));
  equal(bad.required.length, 0);
});

test("resolveMustRead: relative path resolves against cwd; absolute stands as given", () => {
  const { required } = resolveMustRead([{ path: "sub/x.mjs", lines: [[1, 1]] }, { path: "C:/abs/y.mjs", lines: [[1, 1]] }], { cwd: "C:/w" });
  ok(/w[\\/]sub[\\/]x\.mjs$/.test(required[0].path));
  equal(required[1].path, "C:/abs/y.mjs");
});

test("resolveMustRead: an absolute index entry path stands as given even when cwd does not contain it", () => {
  const doc = JSON.stringify({ entries: [{ path: "C:/elsewhere/z.mjs", lines: [[1, 3]] }] });
  const { required } = resolveMustRead([{ index: "C:/idx/i.json" }], { cwd: "C:/totally/other", readFile: rf({ "C:/idx/i.json": doc }) });
  equal(required[0].path, "C:/elsewhere/z.mjs");
});

// ── checkCoverage (pure) ──────────────────────────────────────────────────────

const req = (path, ranges, whole = false) => ({ path, ranges, whole });

test("checkCoverage: a single Read covering [1,n] → complete", () => {
  const cov = checkCoverage([req("C:/a.mjs", [[1, 100]])], [{ file: "C:/a.mjs", offset: 1, limit: 100 }]);
  equal(cov.status, "complete");
  equal(cov.read, 1);
});

test("checkCoverage: 2500-line whole-file, one un-paged Read → missed ['<path>:2001-2500'] (cap literal 2000)", () => {
  const cov = checkCoverage([req("C:/a.mjs", [[1, 2500]], true)], [{ file: "C:/a.mjs", offset: 1, limit: 2000 }]);
  deepEqual(cov.missed, ["C:/a.mjs:2001-2500"]); // mutation: any Read of the path = full coverage
  equal(cov.status, "incomplete");
});

test("checkCoverage: two overlapping Reads cover [[1,1000],[1001,1830],[1831,2500]] — union, not per-call", () => {
  const cov = checkCoverage(
    [req("C:/a.mjs", [[1, 1000], [1001, 1830], [1831, 2500]])],
    [{ file: "C:/a.mjs", offset: 1, limit: 1500 }, { file: "C:/a.mjs", offset: 1001, limit: 1500 }],
  );
  equal(cov.status, "complete"); // mutation: require one Read per range → incomplete
});

test("checkCoverage: a gap between reads misses the uncovered middle", () => {
  const cov = checkCoverage([req("C:/a.mjs", [[1, 2000]])], [{ file: "C:/a.mjs", offset: 1, limit: 1000 }, { file: "C:/a.mjs", offset: 1201, limit: 800 }]);
  ok(cov.missed.some((m) => m === "C:/a.mjs:1001-1200"));
});

test("mergeIntervals: exactly-adjacent windows [1,1000] and [1001,2000] fuse into ONE [[1,2000]] (join on end+1)", () => {
  // Assert on the mechanism's own output — a single merged interval — not on a
  // downstream status, which subtract() reaches either way (that pin is decorative).
  deepEqual(mergeIntervals([[1, 1000], [1001, 2000]]), [[1, 2000]]); // mutation: join on start<=end → two intervals
});

test("mergeIntervals: a one-line gap does NOT fuse — [1,1000] and [1002,2000] stay two", () => {
  deepEqual(mergeIntervals([[1, 1000], [1002, 2000]]), [[1, 1000], [1002, 2000]]);
});

test("checkCoverage: whole-file entry with NOTHING read → bare '<path>' in missed", () => {
  const cov = checkCoverage([req("C:/a.mjs", [[1, 100]], true)], []);
  deepEqual(cov.missed, ["C:/a.mjs"]);
});

test("checkCoverage: path match is case-insensitive + separator-normalised on win32 (namesEqual)", () => {
  if (process.platform !== "win32") return;
  const cov = checkCoverage([req("C:\\a\\b.md", [[1, 10]])], [{ file: "C:/a/b.md", offset: 1, limit: 10 }]);
  equal(cov.status, "complete"); // mutation: strict string compare on win32
});

test("checkCoverage: read/required counts per item; status complete iff missed empty", () => {
  const cov = checkCoverage([req("C:/a.mjs", [[1, 10]]), req("C:/b.mjs", [[1, 10]])], [{ file: "C:/a.mjs", offset: 1, limit: 10 }]);
  equal(cov.required, 2);
  equal(cov.read, 1);
  equal(cov.status, "incomplete");
});

// ── The RED anchor — real transcripts through the real index ──────────────────

const INDEX = () => JSON.parse(fixture("stage4-index.json")).entries;

test("RED anchor: rv-maintainability × stage4-index → incomplete, read 1 (cross-cutting), shards + principles_maintainability missed", () => {
  const reads = parseReadCalls(fixture("rv-maintainability.assistant.jsonl"), "claude");
  const { required } = resolveMustRead(INDEX(), { cwd: "C:/code/claude-plugin-marketplace" });
  const cov = checkCoverage(required, reads);
  equal(cov.status, "incomplete");
  equal(cov.read, 1); // only principles_cross_cutting.md (read with limit 80 ⊇ [1,71])
  ok(cov.missed.some((m) => /scheduler\.mjs/.test(m)), "scheduler shard must be missed");
  ok(cov.missed.some((m) => /principles_maintainability\.md/.test(m)), "maintainability principle must be missed");
});

test("RED anchor: rv-architecture × stage4-index → incomplete; principle reads parse; persisted tool-results read satisfies no shard", () => {
  const reads = parseReadCalls(fixture("rv-architecture.assistant.jsonl"), "claude");
  equal(reads.length, 3); // two principle reads + the harness-persisted tool-results file
  const { required } = resolveMustRead(INDEX(), { cwd: "C:/code/claude-plugin-marketplace" });
  const cov = checkCoverage(required, reads);
  equal(cov.status, "incomplete");
  ok(cov.missed.some((m) => /scheduler\.mjs/.test(m))); // mutation: match on basename → tool-results .txt would not help anyway; the shards stay missed
});

test("RED anchor GREEN control: synthetic paged reads covering every index entry → complete", () => {
  const entries = INDEX();
  const { required } = resolveMustRead(entries, { cwd: "C:/code/claude-plugin-marketplace" });
  const reads = required.flatMap((r) => r.ranges.map(([a, b]) => ({ file: r.path, offset: a, limit: b - a + 1 })));
  const cov = checkCoverage(required, reads);
  equal(cov.status, "complete"); // proves the checker CAN go green — the RED rows aren't an always-fail
});

// ── computeCoverage + coverageErrorLines ──────────────────────────────────────

test("computeCoverage: reads===null (unparseable/unsupported) → every entry missed, status unparseable", () => {
  const cov = computeCoverage([{ path: "C:/a.mjs", lines: [[1, 10]] }], null, { cwd: "C:/w" });
  equal(cov.status, "unparseable");
  equal(cov.required, 1);
  equal(cov.read, 0);
  deepEqual(cov.missed, ["C:/a.mjs"]);
});

test("computeCoverage: resolve errors (unreadable) merge into missed and force incomplete", () => {
  const cov = computeCoverage(["C:/gone.md"], [], { cwd: "C:/w", readFile: rf({}) });
  equal(cov.status, "incomplete");
  ok(cov.missed.some((m) => /unreadable: ENOENT/.test(m)));
});

test("coverageErrorLines: one Read line per uncovered range; a >2000 range splits into 2000-line reads", () => {
  const lines = coverageErrorLines([{ path: "C:/a.mjs", ranges: [[2001, 2500]] }, { path: "C:/b.mjs", ranges: [[1, 4500]] }]);
  ok(lines.some((l) => l === "C:/a.mjs lines 2001-2500: Read offset 2001 limit 500"));
  ok(lines.some((l) => l === "C:/b.mjs lines 1-2000: Read offset 1 limit 2000"));
  ok(lines.some((l) => l === "C:/b.mjs lines 2001-4000: Read offset 2001 limit 2000"));
  ok(lines.some((l) => l === "C:/b.mjs lines 4001-4500: Read offset 4001 limit 500"));
});
