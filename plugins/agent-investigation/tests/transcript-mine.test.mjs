import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  iterEvents, iterToolUses, iterToolResults,
  inputSimilarity, inputBrief, normalizePath,
  cmdTools, cmdErrors, cmdRetries, cmdNgrams,
} from "../scripts/transcript-mine.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpJsonl(lines) {
  const path = join(tmpdir(), `tm-test-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

function withTmpJsonl(lines, fn) {
  const path = tmpJsonl(lines);
  try { return fn(path); }
  finally { try { unlinkSync(path); } catch {} }
}

async function withTmpJsonlAsync(lines, fn) {
  const path = tmpJsonl(lines);
  try { return await fn(path); }
  finally { try { unlinkSync(path); } catch {} }
}

async function collect(gen) {
  const out = [];
  for await (const item of gen) out.push(item);
  return out;
}

// Minimal JSONL fixtures
const TOOL_USE_EV = (id, name, input) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const TOOL_RESULT_EV = (tool_use_id, content, is_error = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id, content, is_error }] },
});

// ---------------------------------------------------------------------------
// iterEvents
// ---------------------------------------------------------------------------

test("iterEvents — yields 0-indexed line numbers as integers", async () => {
  await withTmpJsonlAsync(
    [{ type: "assistant" }, { type: "user" }],
    async (path) => {
      const items = await collect(iterEvents(path));
      assert.equal(items.length, 2);
      assert.equal(items[0][0], 0, "first event should be line 0");
      assert.equal(items[1][0], 1, "second event should be line 1");
      assert.equal(typeof items[0][0], "number", "line index must be a number");
      assert.ok(!isNaN(items[0][0]), "line index must not be NaN");
    }
  );
});

test("iterEvents — skips blank lines without consuming line count", async () => {
  const path = join(tmpdir(), `tm-blank-${process.pid}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "a" })}\n\n${JSON.stringify({ type: "b" })}\n`, "utf8");
  try {
    const items = await collect(iterEvents(path));
    assert.equal(items.length, 2);
    assert.equal(items[0][0], 0);
    assert.equal(items[1][0], 2, "blank line should advance the counter");
  } finally { try { unlinkSync(path); } catch {} }
});

test("iterEvents — skips malformed JSON without throwing", async () => {
  const path = join(tmpdir(), `tm-bad-${process.pid}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "ok" })}\nnot-json\n${JSON.stringify({ type: "ok2" })}\n`, "utf8");
  try {
    const items = await collect(iterEvents(path));
    assert.equal(items.length, 2, "should yield only the two valid events");
    assert.equal(items[0][1].type, "ok");
    assert.equal(items[1][1].type, "ok2");
  } finally { try { unlinkSync(path); } catch {} }
});

// ---------------------------------------------------------------------------
// iterToolUses / iterToolResults
// ---------------------------------------------------------------------------

test("iterToolUses — extracts tool_use blocks from assistant events", async () => {
  const events = [
    TOOL_USE_EV("id1", "Read", { file_path: "/foo" }),
    TOOL_RESULT_EV("id1", "file content"),
    TOOL_USE_EV("id2", "Edit", { file_path: "/bar", old_string: "x", new_string: "y" }),
  ];
  await withTmpJsonlAsync(events, async (path) => {
    const uses = await collect(iterToolUses(path));
    assert.equal(uses.length, 2);
    assert.equal(uses[0][1].name, "Read");
    assert.equal(uses[1][1].name, "Edit");
  });
});

test("iterToolResults — extracts tool_result blocks from user events", async () => {
  const events = [
    TOOL_USE_EV("id1", "Bash", { command: "ls" }),
    TOOL_RESULT_EV("id1", "file.txt", false),
    TOOL_RESULT_EV("id2", "error", true),
  ];
  await withTmpJsonlAsync(events, async (path) => {
    const results = await collect(iterToolResults(path));
    assert.equal(results.length, 2);
    assert.equal(results[0][1].is_error, false);
    assert.equal(results[1][1].is_error, true);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("inputSimilarity — identical inputs → 1.0", () => {
  const a = { file_path: "/foo", old_string: "x" };
  assert.equal(inputSimilarity(a, a), 1);
});

test("inputSimilarity — completely different inputs → 0.0", () => {
  assert.equal(inputSimilarity({ a: "1" }, { b: "2" }), 0);
});

test("inputSimilarity — partial overlap", () => {
  const sim = inputSimilarity({ x: "a", y: "b" }, { x: "a", y: "c" });
  assert.ok(sim > 0 && sim < 1);
});

test("inputBrief — empty dict", () => {
  assert.equal(inputBrief({}), "(empty)");
});

test("inputBrief — single key", () => {
  const r = inputBrief({ file_path: "/foo/bar.mjs" });
  assert.ok(r.includes("file_path"));
  assert.ok(r.includes("/foo/bar.mjs"));
});

test("normalizePath — backslash to forward slash", () => {
  assert.equal(normalizePath("C:\\foo\\bar"), "c:/foo/bar");
});

test("normalizePath — git bash path /c/foo → c:/foo", () => {
  assert.equal(normalizePath("/c/foo"), "c:/foo");
});

test("normalizePath — null passthrough", () => {
  assert.equal(normalizePath(null), null);
});

// ---------------------------------------------------------------------------
// cmdTools — smoke test (output to console.log captured)
// ---------------------------------------------------------------------------

test("cmdTools — runs without error on valid JSONL", async () => {
  const events = [
    TOOL_USE_EV("id1", "Read", { file_path: "/a" }),
    TOOL_RESULT_EV("id1", "ok"),
    TOOL_USE_EV("id2", "Read", { file_path: "/b" }),
    TOOL_RESULT_EV("id2", "ok"),
    TOOL_USE_EV("id3", "Edit", { file_path: "/a", old_string: "x", new_string: "y" }),
    TOOL_RESULT_EV("id3", "ok"),
  ];
  const lines = [];
  await withTmpJsonlAsync(events, async (path) => {
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await cmdTools(path, 5); }
    finally { console.log = orig; }
  });
  assert.ok(lines.some(l => l.includes("Read")), "output should mention Read tool");
  assert.ok(lines.some(l => l.includes("Edit")), "output should mention Edit tool");
});

// ---------------------------------------------------------------------------
// cmdErrors — smoke test
// ---------------------------------------------------------------------------

test("cmdErrors — reports errors with use-line context", async () => {
  const events = [
    TOOL_USE_EV("id1", "Bash", { command: "bad-command" }),
    TOOL_RESULT_EV("id1", "command not found", true),
  ];
  const lines = [];
  await withTmpJsonlAsync(events, async (path) => {
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await cmdErrors(path); }
    finally { console.log = orig; }
  });
  assert.ok(lines.some(l => l.includes("1 errored")), "should report 1 error");
  assert.ok(lines.some(l => l.includes("Bash")), "should name the tool");
});

// ---------------------------------------------------------------------------
// cmdRetries — smoke test
// ---------------------------------------------------------------------------

test("cmdRetries — detects retry pair with identical input", async () => {
  const inp = { file_path: "/foo/bar.mjs" };
  const events = [
    TOOL_USE_EV("id1", "Read", inp),
    TOOL_RESULT_EV("id1", "ok"),
    TOOL_USE_EV("id2", "Read", inp),
    TOOL_RESULT_EV("id2", "ok"),
  ];
  const lines = [];
  await withTmpJsonlAsync(events, async (path) => {
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await cmdRetries(path, 5); }
    finally { console.log = orig; }
  });
  assert.ok(lines.some(l => l.includes("1 suspected")), "should detect 1 retry");
});

// ---------------------------------------------------------------------------
// cmdNgrams — smoke test
// ---------------------------------------------------------------------------

test("cmdNgrams — counts trigrams correctly", async () => {
  const events = [
    TOOL_USE_EV("a1", "Read", {}), TOOL_RESULT_EV("a1", "ok"),
    TOOL_USE_EV("a2", "Grep", {}), TOOL_RESULT_EV("a2", "ok"),
    TOOL_USE_EV("a3", "Edit", {}), TOOL_RESULT_EV("a3", "ok"),
    TOOL_USE_EV("a4", "Read", {}), TOOL_RESULT_EV("a4", "ok"),
    TOOL_USE_EV("a5", "Grep", {}), TOOL_RESULT_EV("a5", "ok"),
    TOOL_USE_EV("a6", "Edit", {}), TOOL_RESULT_EV("a6", "ok"),
  ];
  const lines = [];
  await withTmpJsonlAsync(events, async (path) => {
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await cmdNgrams(path, 3, 5); }
    finally { console.log = orig; }
  });
  assert.ok(lines.some(l => l.includes("Read") && l.includes("Grep") && l.includes("Edit")), "should surface Read→Grep→Edit trigram");
});
