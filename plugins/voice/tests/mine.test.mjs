import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mine, humanTurn, cleanTurn, classifyTurn, wordCount } from "../src/mine.mjs";
import { buildSample } from "../src/sample.mjs";

const line = (o) => JSON.stringify(o);
const human = (text, extra = {}) => ({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, timestamp: "2026-08-01T00:00:00Z", sessionId: "s1", ...extra });

test("humanTurn keeps human/channel, drops machine origins, tool results, sdk, meta", () => {
  assert.ok(humanTurn(human("hello there"), "/p/a.jsonl"));
  assert.ok(humanTurn(human("hi", { origin: { kind: "channel" } }), "/p/a.jsonl"));
  assert.equal(humanTurn(human("x", { origin: { kind: "task-notification" } }), "/p/a.jsonl"), null);
  assert.equal(humanTurn(human("x", { origin: { kind: "auto-continuation" } }), "/p/a.jsonl"), null);
  assert.equal(humanTurn(human("x", { isMeta: true }), "/p/a.jsonl"), null);
  assert.equal(humanTurn(human("x", { isSidechain: true }), "/p/a.jsonl"), null);
  assert.equal(humanTurn({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] }, origin: { kind: "human" } }, "/p/a.jsonl"), null);
  // legacy (no origin): sdk-cli rejected, cli kept
  assert.equal(humanTurn({ type: "user", message: { content: "x" }, entrypoint: "sdk-cli" }, "/p/a.jsonl"), null);
  assert.ok(humanTurn({ type: "user", message: { content: "x" }, entrypoint: "cli" }, "/p/a.jsonl"));
});

test("cleanTurn strips harness injections and keeps slash-command args", () => {
  assert.equal(cleanTurn("real text<system-reminder>noise</system-reminder>"), "real text");
  assert.equal(cleanTurn("<command-name>/plan</command-name><command-message>plan</command-message><command-args>do the thing</command-args>"), "do the thing");
  assert.equal(humanTurn(human("Cache keepalive tick"), "/p/a.jsonl"), null);
  assert.equal(humanTurn(human("<bash-input>ls</bash-input>"), "/p/a.jsonl"), null);
});

test("classifyTurn tags pasted claude output, logs and code", () => {
  assert.equal(classifyTurn("● Done. The fix is in.\n\n  - item\n  - item"), "pasted-claude");
  assert.equal(classifyTurn("[indexer] Installing tree-sitter"), "pasted-log");
  assert.equal(classifyTurn("[2026/07/23 20:00:24] N: WS closed"), "pasted-log");
  assert.equal(classifyTurn("import x from 'y'\nexport const a = 1"), "pasted-code");
  assert.equal(classifyTurn("ok so back to cladding"), "typed");
});

test("wordCount handles languages without spaces", () => {
  assert.equal(wordCount("das ist ein Test"), 4);
  assert.ok(wordCount("これはテストです") >= 3);
});

test("mine walks transcripts, skips swarm/subagent/agent files, dedupes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-mine-"));
  const proj = path.join(root, "C--code-x"); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "a.jsonl"), [line(human("first turn here")), line(human("first turn here")), line(human("zweiter Text, bitte prüfen")), ""].join("\n"));
  fs.writeFileSync(path.join(proj, "agent-1.jsonl"), line(human("machine authored")) + "\n");
  const sw = path.join(root, "C--x--swarm-runs-foo"); fs.mkdirSync(sw);
  fs.writeFileSync(path.join(sw, "b.jsonl"), line(human("swarm leaf prompt")) + "\n");
  const out = path.join(root, "out", "turns.jsonl");
  const { turns, stats } = await mine({ transcriptsDir: root, outFile: out });
  assert.equal(turns.length, 2);
  assert.equal(stats.dup, 1);
  assert.ok(fs.existsSync(out));
  assert.ok(!turns.some(t => /machine|swarm/.test(t.text)));
});

test("buildSample is deterministic and typed-only", () => {
  const turns = Array.from({ length: 300 }, (_, i) => ({ ts: `2026-08-${String(i % 28 + 1).padStart(2, "0")}`, kind: i % 10 === 0 ? "pasted-claude" : "typed", words: (i % 4) * 60 + 5, text: `turn ${i} ` + "w ".repeat((i % 4) * 60) }));
  const a = buildSample(turns), b = buildSample(turns);
  assert.equal(a.markdown, b.markdown);
  assert.ok(a.count > 100);
  assert.ok(!/turn 10 /.test(a.markdown));
});
