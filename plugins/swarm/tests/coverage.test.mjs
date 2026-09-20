// Engine-checked leaf read coverage — all tests for src/coverage.mjs and its
// scheduler/manifest/CLI integration live in this one file (the citations.test.mjs
// precedent). RED first; every assertion compares against a source literal, never
// the constant it pins.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseReadCalls, resolveMustRead, checkCoverage, computeCoverage,
  coverageErrorLines, READ_DEFAULT_LINES, mergeIntervals,
} from "../src/coverage.mjs";
import { effectivePlanDoc, ValidationError, MUST_READ_MAX_ENTRIES } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { runnerOf } from "../src/dispatch.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { readResult, transcriptPath } from "../src/results.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";

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

// A relative entry resolves against cwd with the host's path rules, so cwd must be
// absolute on this platform — "C:/w" is relative on Linux and the lookup misses.
const W = resolve("/w");

test("resolveMustRead: string entry → [[1,n]], trailing newline not counted", () => {
  const { required } = resolveMustRead(["a.md"], { cwd: W, readFile: rf({ [join(W, "a.md")]: "a\nb\n" }) });
  equal(required.length, 1);
  deepEqual(required[0].ranges, [[1, 2]]); // mutation: naive split("\n").length → 3
  equal(required[0].whole, true);
});

test("resolveMustRead: empty file → no required range", () => {
  const { required, errors } = resolveMustRead(["e.md"], { cwd: W, readFile: rf({ [join(W, "e.md")]: "" }) });
  deepEqual(errors, []); // an unreadable file also yields no range — this pins that it was read
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

// ── runnerOf (dispatch) ───────────────────────────────────────────────────────

test("runnerOf: a Claude model → claude; env-mode non-claude (proxied through claude CLI) → claude", () => {
  equal(runnerOf({ model: "haiku" }, {}), "claude");
  equal(runnerOf({ model: "glm-4.6:cloud" }, { provider: { mode: "env", url: "x", authToken: "y" } }), "claude");
});

test("runnerOf: launch-mode wrapper whose binary isn't claude → that binary name (the rejection trigger)", () => {
  const cfg = { provider: { mode: "launch", launchCmd: "ollama launch claude --model {model} -- {args}" } };
  equal(runnerOf({ model: "glm-4.6:cloud" }, cfg), "ollama"); // mutation: return "claude" for launch mode → nothing is ever rejected
  // a launch template that IS a direct claude invocation stays claude
  equal(runnerOf({ model: "sonnet" }, { provider: { mode: "launch", launchCmd: "claude {args}" } }), "claude");
});

// ── manifest: mustRead shape validation, normalisation, effectivePlanDoc ───────

const manCfg = { provider: { allowedRoots: [] }, concurrency: 4, timeoutMs: 600000, resultInlineCap: 4000 };
function writeMan(dir, body, name = "plan.json") { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; }
function manErrors(fn) {
  try { fn(); } catch (e) { ok(e instanceof ValidationError, `expected ValidationError, got ${e}`); return e.errors; }
  throw new Error("expected loadManifest to throw");
}

test("mustRead: string, paged, index+lane, {{resultPath:<dep>}} all accepted and carried through normalisation + effectivePlanDoc", () => {
  const dir = tmp();
  try {
    const mr = ["README.md", { path: "a.mjs", lines: [[1, 50]] }, { index: "idx.json", lane: 0 }];
    const p = writeMan(dir, { tasks: [
      { id: "finder", prompt: "find", model: "haiku" },
      { id: "vf", prompt: "verify", model: "haiku", after: ["finder"], mustRead: [...mr, "{{resultPath:finder}}"] },
    ] });
    const plan = loadManifest(p, manCfg, dir);
    const vf = plan.tasks.find((t) => t.id === "vf");
    deepEqual(vf.mustRead, [...mr, "{{resultPath:finder}}"]); // normalisation carries it
    const doc = effectivePlanDoc(plan);
    const vfDoc = doc.tasks.find((t) => t.id === "vf");
    deepEqual(vfDoc.mustRead, [...mr, "{{resultPath:finder}}"]); // effectivePlanDoc keeps it
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: rejected on compute / integrate / manifest nodes — needs a leaf", () => {
  const dir = tmp();
  try {
    const p = writeMan(dir, { tasks: [
      { id: "a", prompt: "x", model: "haiku" },
      { id: "c", compute: "deps['a'].y", after: ["a"], mustRead: ["README.md"] },
    ] });
    const errs = manErrors(() => loadManifest(p, manCfg, dir));
    ok(errs.some((e) => /mustRead needs a leaf/.test(e)), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: KNOWN_TASK_KEYS advertises it (a typo'd sibling key still reports); MANIFEST_BANNED_KEYS rejects it on a manifest node", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: [{ id: "k", prompt: "x", model: "haiku" }] }));
    const p = writeMan(dir, { tasks: [{ id: "m", manifest: "child.json", mustRead: ["README.md"] }] });
    const errs = manErrors(() => loadManifest(p, manCfg, dir));
    ok(errs.some((e) => /manifest task is an agentless container/.test(e) && /mustRead/.test(e)), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: per-error teaching for lines-not-pairs, start>end, negative lane, unknown key, both path+index", () => {
  const dir = tmp();
  try {
    const p = writeMan(dir, { tasks: [{ id: "a", prompt: "x", model: "haiku", mustRead: [
      { path: "a.mjs", lines: [[1]] },
      { path: "b.mjs", lines: [[50, 10]] },
      { index: "i.json", lane: -1 },
      { path: "c.mjs", limit: 5 },
      { path: "d.mjs", index: "e.json" },
    ] }] });
    const errs = manErrors(() => loadManifest(p, manCfg, dir));
    ok(errs.some((e) => /pairs/.test(e)), "lines-not-pairs");
    ok(errs.some((e) => /start > end/.test(e)), "start>end");
    ok(errs.some((e) => /lane/.test(e) && /non-negative/.test(e)), "negative lane");
    ok(errs.some((e) => /unknown key 'limit' in mustRead/.test(e)), "unknown key");
    ok(errs.some((e) => /both path and index/.test(e)), "both path+index");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: {{resultPath:x}} where x ∉ after → error; {{result:x}} anywhere → error", () => {
  const dir = tmp();
  try {
    const p = writeMan(dir, { tasks: [{ id: "a", prompt: "x", model: "haiku", mustRead: ["{{resultPath:ghost}}", "{{result:a}}"] }] });
    const errs = manErrors(() => loadManifest(p, manCfg, dir));
    ok(errs.some((e) => /ghost/.test(e) && /declared dependency/.test(e)), "resultPath dep");
    ok(errs.some((e) => /only \{\{resultPath:<id>\}\} is substituted/.test(e)), "non-resultPath template");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: an empty array is an error, never a vacuous complete", () => {
  // RED: no length check — required 0 stamps coverage complete and validate announces enforcement.
  const dir = tmp();
  try {
    const p = writeMan(dir, { tasks: [{ id: "a", prompt: "x", model: "haiku", mustRead: [] }] });
    const errs = manErrors(() => loadManifest(p, manCfg, dir));
    ok(errs.some((e) => /'a': mustRead is empty/.test(e)), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: over MUST_READ_MAX_ENTRIES → error suggesting an index", () => {
  const dir = tmp();
  try {
    const many = Array.from({ length: MUST_READ_MAX_ENTRIES + 1 }, (_, i) => `f${i}.md`);
    const p = writeMan(dir, { tasks: [{ id: "a", prompt: "x", model: "haiku", mustRead: many }] });
    const errs = manErrors(() => loadManifest(p, manCfg, dir));
    ok(errs.some((e) => new RegExp(`over the ${MUST_READ_MAX_ENTRIES}`).test(e) && /index/.test(e)), errs.join("\n"));
    equal(MUST_READ_MAX_ENTRIES, 500); // source literal
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: a non-claude runner task is rejected naming the runner, with NO win32 guard (io.platform linux still rejects)", () => {
  const dir = tmp();
  try {
    const cfg = { ...manCfg, provider: { mode: "launch", launchCmd: "ollama launch claude --model {model} -- {args}", allowedRoots: [dir] } };
    const p = writeMan(dir, { tasks: [{ id: "a", prompt: "x", model: "glm-4.6:cloud", mustRead: ["README.md"] }] });
    const errs = manErrors(() => loadManifest(p, cfg, dir, { io: { platform: "linux" } }));
    ok(errs.some((e) => /runner 'ollama' is not supported/.test(e)), errs.join("\n")); // mutation: win32 guard → passes on linux
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── enforceLeafContract integration (runPlan + fake io) ───────────────────────

const iCfg = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "x", allowedRoots: [] },
  concurrency: 4, timeoutMs: 600000, resultInlineCap: 4000, worktreeBranchPrefix: "swarm/",
};
const iTask = (id, cwd, over = {}) => ({
  id, prompt: `do ${id}`, model: "haiku", allowedTools: "Read,Grep,Glob",
  cwd, originalCwd: cwd, timeoutMs: 5000, after: [], ...over,
});
const iPlan = (dir, tasks) => ({ cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "" });
// One claude leaf's stdout: an init (session id), Read turns, and a success result.
// withAsst:false omits the assistant event entirely — the unparseable case.
const leafOut = (reads, { sid = "s-1", result = "done", withInit = true } = {}) => [
  ...(withInit ? [JSON.stringify({ type: "system", subtype: "init", session_id: sid })] : []),
  ...(reads.length ? readTurns(reads) : []),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result }),
].join("\n") + "\n";
const noAsstOut = ({ sid = "s-1", result = "done" } = {}) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: sid }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result }),
].join("\n") + "\n";
const logEvents = (dir) => readFileSync(join(dir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const writeLines = (dir, name, n) => { const p = join(dir, name); writeFileSync(p, "x\n".repeat(n)); return p; };
const ANSWER_SCHEMA = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };

test("integration: mustRead complete on first pass → no re-ask; coverage complete; run.log coverage retried:false", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }]) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    deepEqual(
      { status: res.coverage.status, required: res.coverage.required, read: res.coverage.read },
      { status: "complete", required: 1, read: 1 },
    );
    ok(logEvents(p.resultsDir).some((l) => l.event === "coverage" && l.id === "a" && l.status === "complete" && l.retried === false));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: incomplete first pass → ONE re-ask naming the gap; appended reads → complete; schemaRetried", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({
      output: leafOut([{ file: F, offset: i === 0 ? 1 : 2001, limit: i === 0 ? 2000 : 500 }], { sid: `s-${i + 1}` }),
    }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 2);
    ok(promptOf(spawn.calls[1]).includes("Read offset 2001 limit 500"), promptOf(spawn.calls[1]));
    const res = readResult(p.resultsDir, "a");
    equal(res.coverage.status, "complete");
    equal(res.schemaRetried, true);
    ok(logEvents(p.resultsDir).some((l) => l.event === "coverage" && l.retried === true && l.status === "complete"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: schema miss AND coverage miss → ONE combined retry carrying both blocks, one spawn", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({
      output: leafOut(
        [{ file: F, offset: i === 0 ? 1 : 2001, limit: i === 0 ? 2000 : 500 }],
        { sid: `s-${i + 1}`, result: i === 0 ? "{}" : JSON.stringify({ answer: "x" }) },
      ),
    }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { returns: ANSWER_SCHEMA, mustRead: [F] })]);
    await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 2);
    const rp = promptOf(spawn.calls[1]);
    ok(rp.includes("returns schema"), rp);
    ok(rp.includes("You did not read everything this task requires"), rp);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.coverage.status, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: still incomplete after the re-ask → leaf ok, output intact, coverage incomplete, summary.coverageGaps", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    // both passes only ever read the first 2000 lines → the 2001-2500 gap survives
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: `s-${i + 1}`, result: "kept" }) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    const r = await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 2);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.output, "kept");
    equal(res.coverage.status, "incomplete");
    ok(res.coverage.missed.some((m) => /2001-2500/.test(m)), res.coverage.missed.join());
    ok(r.summary.coverageGaps?.some((g) => g.id === "a" && g.status === "incomplete"), JSON.stringify(r.summary.coverageGaps));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: unparseable transcript on an ok leaf → status unparseable, all items missed, re-ask fires", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const spawn = fakeSpawnFactory(() => ({ output: noAsstOut() }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 2); // the re-ask still fires on an unparseable first pass
    ok(promptOf(spawn.calls[1]).includes("You did not read everything this task requires"));
    const res = readResult(p.resultsDir, "a");
    equal(res.coverage.status, "unparseable");
    deepEqual(res.coverage.missed, [F]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: no session id → no re-ask; coverage annotated from the first pass", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { withInit: false }) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.coverage.status, "incomplete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: mustRead WITHOUT returns still runs the contract (re-ask fires, output untouched)", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: `s-${i + 1}`, result: "prose answer" }) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]); // no returns
    await runPlan(p, iCfg, io);
    equal(spawn.calls.length, 2); // mutation: gate on task.returns → no re-ask, one spawn
    const res = readResult(p.resultsDir, "a");
    equal(res.output, "prose answer");
    ok(res.coverage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: a coverage re-ask on a task with no returns never demands JSON", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: `s-${i + 1}`, result: "prose answer" }) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]); // no returns: a prose leaf
    await runPlan(p, iCfg, io);
    const rp = promptOf(spawn.calls[1]);
    ok(rp.includes("You did not read everything this task requires"), rp);
    ok(!/JSON/.test(rp), `a prose leaf was told to answer in JSON:\n${rp}`); // mutation: unconditional JSON line → fails
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: a coverage re-ask on a task WITH returns still demands the corrected JSON", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    const spawn = fakeSpawnFactory((call, i) => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }], { sid: `s-${i + 1}`, result: "{\"ok\":true}" }) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F], returns: { type: "object" } })]);
    await runPlan(p, iCfg, io);
    ok(promptOf(spawn.calls[1]).includes("Reply with ONLY the corrected JSON"), promptOf(spawn.calls[1])); // mutation: drop the JSON line entirely → fails
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: resume opens the transcript with flags:a — a --force run truncates", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "big.mjs", 2500);
    // run 1: the leaf FAILS (exit 1) but records a session and a first-2000 Read
    const spawn1 = fakeSpawnFactory(() => ({ exit: 1, output: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      ...readTurns([{ file: F, offset: 1, limit: 2000 }]),
    ].join("\n") + "\n" }));
    const io1 = makeIo(spawn1);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    await runPlan(p, iCfg, io1);
    equal(readResult(p.resultsDir, "a").ok, false);

    // run 2: resume (not --force). Its Read of 2001-2500 must APPEND to run 1's log,
    // so the combined transcript covers the whole file.
    const spawn2 = fakeSpawnFactory(() => ({ output: leafOut([{ file: F, offset: 2001, limit: 500 }], { sid: "s-2" }) }));
    const io2 = makeIo(spawn2);
    await runPlan(p, iCfg, io2);
    const log = readFileSync(transcriptPath(p.resultsDir, "a"), "utf8");
    ok(/"offset":1[,}]/.test(log) && /"offset":2001/.test(log), "both attempts' Reads present"); // mutation: always truncate → only 2001 present
    equal(readResult(p.resultsDir, "a").coverage.status, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: a child manifest's mustRead {{resultPath:local}} is remapped by expandManifest", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [
        { id: "finder", prompt: "find", model: "haiku", allowedTools: "Read" },
        { id: "vf", prompt: "verify {{result:finder}}", model: "haiku", allowedTools: "Read", after: ["finder"], mustRead: ["{{resultPath:finder}}"] },
      ],
    }));
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([], { result: "x" }) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [{ ...iTask("node", dir), childPlan: { tasks: [
      { id: "finder", prompt: "find", model: "haiku", allowedTools: "Read", after: [] },
      { id: "vf", prompt: "verify {{result:finder}}", model: "haiku", allowedTools: "Read", after: ["finder"], mustRead: ["{{resultPath:finder}}"] },
    ] } }]);
    await runPlan(p, iCfg, io);
    const res = readResult(p.resultsDir, "node~vf");
    ok(res.coverage, "vf carries coverage");
    // remap: {{resultPath:finder}} → the finder's REAL result file (node~finder.json, which
    // exists) — a whole-file entry the leaf read nothing of, so it lands in missed by name.
    // mutation (un-remapped): {{resultPath:finder}} → a nonexistent finder.json → unreadable.
    ok(res.coverage.missed.some((m) => m.includes("node~finder.json")), JSON.stringify(res.coverage));
    ok(!res.coverage.missed.some((m) => /unreadable/.test(m)), JSON.stringify(res.coverage));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: swarm ask on a mustRead leaf runs no contract — no coverage event, coverage unchanged", async () => {
  const dir = tmp();
  try {
    const F = writeLines(dir, "f.mjs", 3);
    const spawn = fakeSpawnFactory(() => ({ output: leafOut([{ file: F, offset: 1, limit: 2000 }]) }));
    const io = makeIo(spawn);
    const p = iPlan(dir, [iTask("a", dir, { mustRead: [F] })]);
    await runPlan(p, iCfg, io);
    const before = readResult(p.resultsDir, "a").coverage;
    const covEventsBefore = logEvents(p.resultsDir).filter((l) => l.event === "coverage").length;
    const io2 = makeIo(fakeSpawnFactory(() => ({ output: leafOut([], { sid: "s-9", result: "an answer" }) })));
    await runPlan(p, iCfg, io2, { ask: { taskId: "a", question: "why?" } });
    const after = readResult(p.resultsDir, "a");
    deepEqual(after.coverage, before); // the ask never re-checks
    equal(logEvents(p.resultsDir).filter((l) => l.event === "coverage").length, covEventsBefore); // no new coverage event
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Docs — the field reference and skill stay truthful ────────────────────────

const SKILLS = fileURLToPath(new URL("../skills/", import.meta.url));
// Body of a markdown section: header line to the next same-or-higher header.
function sectionBody(md, header) {
  const i = md.indexOf(header);
  if (i < 0) return null;
  const after = md.slice(i + header.length);
  const end = after.search(/\n#{1,3} /);
  return end < 0 ? after : after.slice(0, end);
}

test("docs: manifest-fields.md mustRead example validates verbatim", () => {
  const md = readFileSync(join(SKILLS, "swarm/manifest-fields.md"), "utf8");
  const body = sectionBody(md, "### Proven read coverage — `mustRead`");
  const fence = body && body.match(/```json\s*([\s\S]*?)```/);
  ok(fence, "no ```json example under the mustRead section");
  const parsed = JSON.parse(fence[1]); // the doc's fence must be real JSON
  const dir = tmp();
  try {
    const p = writeMan(dir, parsed);
    const plan = loadManifest(p, manCfg, dir); // must not throw ValidationError
    const t = plan.tasks.find((x) => Array.isArray(x.mustRead));
    ok(t && t.mustRead.length === 2, JSON.stringify(t)); // string + paged entry carried through
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("docs: swarm/SKILL.md adversarial-review states the tier rule, not 'different model family'", () => {
  const md = readFileSync(join(SKILLS, "swarm/SKILL.md"), "utf8");
  const sec = sectionBody(md, "### Adversarial review");
  ok(sec, "adversarial-review section not found in swarm/SKILL.md");
  ok(!/different model family/i.test(sec), "still says 'different model family' — reconcile to the tier rule");
  ok(/different tier/i.test(sec), "expected the Claude-verifier tier rule in the section");
});
