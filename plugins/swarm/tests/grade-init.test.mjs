import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { ASPECTS } from "../src/aspects.mjs";
import { OUTCOME_CHOICES, buildSkeleton, noteFor, outcomeFor, tldrLine } from "../src/grade-init.mjs";

const PLACEHOLDER = OUTCOME_CHOICES;

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-grade-init-"));
}

// A finished run whose leaves span every state the pre-fill can read.
function fakeRun(dir) {
  const run = join(dir, "run-1");
  mkdirSync(join(run, "results"), { recursive: true });
  const write = (id, obj) => writeFileSync(join(run, "results", `${id}.json`), JSON.stringify(obj, null, 2));
  write("clean", { id: "clean", provider: "ollama", model: "glm-5.2:cloud", ok: true, exit: 0, durationMs: 41000, output: "TL;DR: moved the icons across.\n\nDetail follows." });
  write("slow", { id: "slow", model: "kimi-k2.7-code:cloud", ok: false, exit: null, timedOut: true, durationMs: 600000, output: "was mid-edit" });
  write("broke", { id: "broke", model: "sonnet", ok: false, exit: 1, durationMs: 9000, output: "TypeError: x is not a function" });
  write("silent", { id: "silent", model: "haiku", ok: true, exit: 0, durationMs: 3000, output: "" });
  writeFileSync(join(run, "manifest.json"), JSON.stringify({ tasks: [{ id: "clean" }] }));
  return run;
}

const leaf = (id, result) => ({ id, model: "m", resultPath: `/r/${id}.json`, transcriptPath: `/r/${id}.log`, result });

test("grade --init pre-fills a clean leaf's outcome as completed", () => {
  equal(outcomeFor({ ok: true, exit: 0, output: "done" }), "completed", "an ok leaf with output is completed, not a placeholder");
});

test("grade --init pre-fills a timed-out leaf's outcome as timeout", () => {
  equal(outcomeFor({ ok: false, exit: null, timedOut: true, output: "was mid-edit" }), "timeout", "the record's timedOut flag wins over the generic failure");
});

test("grade --init pre-fills a failed leaf's outcome as failed", () => {
  equal(outcomeFor({ ok: false, exit: 1, output: "boom" }), "failed", "a non-timeout non-zero exit is failed");
});

test("grade --init never pre-fills wrong — it is the grader's judgement", () => {
  for (const result of [{ ok: true, output: "x" }, { ok: false, output: "x" }, { ok: false, timedOut: true, output: "x" }]) {
    ok(outcomeFor(result) !== "wrong", "wrong is a verdict only a human reaches; the pre-fill must never reach it");
  }
});

test("grade --init leaves the outcome placeholder when the leaf said nothing", () => {
  equal(outcomeFor({ ok: true, exit: 0, output: "" }), PLACEHOLDER, "a leaf with no output cannot be called completed, however it exited");
  equal(outcomeFor({ ok: true, exit: 0, output: "   \n" }), PLACEHOLDER, "whitespace-only output is no output");
});

test("grade --init still pre-fills timeout/failed for a leaf that produced no output", () => {
  equal(outcomeFor({ ok: false, timedOut: true, output: "" }), "timeout", "the state settles it even with no output");
  equal(outcomeFor({ ok: false, exit: 1, output: "" }), "failed", "the state settles it even with no output");
});

test("grade --init leaves the outcome placeholder when no state is recorded", () => {
  equal(outcomeFor(null), PLACEHOLDER, "an absent record keeps the placeholder");
  equal(outcomeFor({}), PLACEHOLDER, "a record with no ok flag keeps the placeholder");
  equal(outcomeFor({ ok: null, output: "x" }), PLACEHOLDER, "a null ok flag keeps the placeholder");
});

test("grade --init quotes the leaf's own TL;DR line", () => {
  equal(tldrLine("tl;dr: moved the icons across.\n\nDetail."), "tl;dr: moved the icons across.", "the TL;DR line is matched case-insensitively");
  equal(noteFor({ output: "TL;DR: moved the icons across.\n\nDetail." }), 'leaf says: "TL;DR: moved the icons across."', "the note is attributed to the leaf, not written as a verdict");
});

test("grade --init falls back to the first non-empty line when there is no TL;DR", () => {
  equal(noteFor({ output: "\n\n  TypeError: x is not a function\n  at foo" }), 'leaf says: "TypeError: x is not a function"', "the first non-empty line is the fallback claim");
});

test("grade --init truncates a long note to about 200 characters", () => {
  const note = noteFor({ output: "x".repeat(500) });
  ok(note.length <= 'leaf says: "'.length + 200 + '…"'.length, `a note must stay short (got ${note.length} chars)`);
  ok(note.endsWith('…"'), "a truncated note is marked as truncated");
});

test("grade --init leaves the note empty when the leaf produced no output", () => {
  equal(noteFor({ output: "" }), "", "no output means no claim to quote");
  equal(noteFor(null), "", "an absent record means no claim to quote");
});

test("buildSkeleton pre-fills outcome and note per leaf, and never a grade", () => {
  const skeleton = buildSkeleton([
    leaf("clean", { ok: true, exit: 0, output: "TL;DR: done" }),
    leaf("slow", { ok: false, timedOut: true, output: "was mid-edit" }),
  ], { resultsDir: "/r" });
  equal(skeleton.rows[0].outcome, "completed", "clean leaf");
  equal(skeleton.rows[0].note, 'leaf says: "TL;DR: done"', "clean leaf note");
  equal(skeleton.rows[1].outcome, "timeout", "timed-out leaf");
  for (const row of skeleton.rows) {
    for (const a of ASPECTS) equal(row.grades[a], null, `${row.leaf}.${a} must never be pre-filled`);
  }
});

test("grade --init writes pre-filled rows and still refuses to be appended unfilled", () => {
  const dir = tmp();
  try {
    const run = fakeRun(dir);
    const r = runCli(["grade", "--init", run], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    const batch = JSON.parse(readFileSync(join(run, "grades.json"), "utf8"));
    const by = Object.fromEntries(batch.rows.map((row) => [row.leaf, row]));
    equal(by.clean.outcome, "completed", "clean leaf");
    equal(by.clean.note, 'leaf says: "TL;DR: moved the icons across."', "clean leaf note");
    equal(by.slow.outcome, "timeout", "timed-out leaf");
    equal(by.broke.outcome, "failed", "failed leaf");
    equal(by.silent.outcome, PLACEHOLDER, "a silent leaf keeps the placeholder");
    equal(by.silent.note, "", "a silent leaf has no claim to quote");
    // the skeleton is still a form, not a grade
    const unfilled = runCli(["grade", "--file", join(run, "grades.json")], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    ok(unfilled.status !== 0, "an untouched skeleton must not append to the store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
