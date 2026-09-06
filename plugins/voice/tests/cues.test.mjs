import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCues, validateCues, runCues, distilCues } from "../src/cues.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "prompt-submit.mjs");

const turns = [
  { kind: "typed", text: "ich denke wir sollten das mergen" },
  { kind: "typed", text: "nein, noch nicht" },
  { kind: "typed", text: "sit rep bitte" },
  { kind: "typed", text: "ok weiter" },
  { kind: "pasted-claude", text: "● ich denke das ist fertig" },
];

test("parseCues tolerates prose around the array and drops malformed entries", () => {
  const out = parseCues('Here you go:\n[{"id":"a","pattern":"x","flags":"gi","meaning":"m","note":"n"},{"id":"bad"}]\nthanks');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: "a", pattern: "x", flags: "gi", meaning: "m", note: "n" });
  assert.throws(() => parseCues("no json here"), /no JSON array/);
});

test("validateCues drops non-compiling, never-firing and over-firing cues; keeps the rest with stats", () => {
  const { kept, dropped } = validateCues([
    { id: "hedge", pattern: "\\bich denke\\b", flags: "i", meaning: "m", note: "n" },
    { id: "broken", pattern: "(", flags: "i", meaning: "m", note: "n" },
    { id: "never", pattern: "zzzz", flags: "i", meaning: "m", note: "n" },
    { id: "always", pattern: ".", flags: "i", meaning: "m", note: "n" },
  ], turns);
  assert.deepEqual(kept.map(c => c.id), ["hedge"]);
  assert.equal(kept[0].fires, 1);           // pasted-claude excluded
  assert.equal(kept[0].enabled, true);
  assert.deepEqual(dropped.map(d => d.id), ["broken", "never", "always"]);
});

test("runCues respects enabled:false and the per-prompt cap", () => {
  const cues = [
    { id: "a", pattern: "x", flags: "i", note: "A", enabled: false },
    { id: "b", pattern: "x", flags: "i", note: "B" },
    { id: "c", pattern: "x", flags: "i", note: "C" },
    { id: "d", pattern: "x", flags: "i", note: "D" },
    { id: "e", pattern: "x", flags: "i", note: "E" },
  ];
  assert.deepEqual(runCues("xxx", cues).map(f => f.id), ["b", "c", "d"]);
  assert.deepEqual(runCues("yyy", cues), []);
});

test("distilCues parses the model's JSON", () => {
  const out = distilCues("S", "P", { _spawn: () => ({ status: 0, stdout: '[{"id":"q","pattern":"\\\\?$","flags":"","meaning":"m","note":"n"}]' }) });
  assert.equal(out[0].pattern, "\\?$");
});

function runHook(payload, home, envExtra = {}) {
  const env = { ...process.env, VOICE_HOME: home };
  delete env.CLAUDE_VOICE; Object.assign(env, envExtra);
  try { return { code: 0, out: execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout || "") }; }
}

test("prompt hook: silent without cues, injects only fired notes, skips keepalive/tags/kill switch", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cues-"));
  assert.deepEqual(runHook({ prompt: "ich denke wir sollten mergen" }, home), { code: 0, out: "" });
  fs.writeFileSync(path.join(home, "cues.json"), JSON.stringify({ cues: [
    { id: "hedge", pattern: "\\bich denke\\b", flags: "i", note: "Als Anweisung lesen.", enabled: true },
    { id: "off", pattern: ".", flags: "i", note: "never", enabled: false },
  ] }));
  const r = runHook({ prompt: "ich denke wir sollten mergen" }, home);
  assert.equal(r.out, '<operator-cues v="1">\n- hedge: Als Anweisung lesen.\n</operator-cues>\n');
  assert.equal(runHook({ prompt: "ok weiter" }, home).out, "");
  assert.equal(runHook({ prompt: "Cache keepalive tick" }, home).out, "");
  assert.equal(runHook({ prompt: "<command-name>/x</command-name> ich denke" }, home).out, "");
  assert.equal(runHook({ prompt: "ich denke" }, home, { CLAUDE_VOICE: "off" }).out, "");
  assert.equal(runHook("garbage", home).code, 0);
});
