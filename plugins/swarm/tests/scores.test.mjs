import { test } from "node:test";
import { equal, deepEqual, ok, throws, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateRow, dedupeKey, dedupe, appendRows, readRows, aggregate, overall, scoresPath, shrink, fairPrior, PRIOR_WEIGHT,
} from "../src/scores.mjs";
import { ASPECTS, OUTCOMES } from "../src/aspects.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-scores-"));
}

// A complete, valid row. Every rejection test below mutates exactly one field
// off this baseline, so a failure names the field it is about.
function row(over = {}) {
  return {
    ts: "2026-08-23T10:00:00Z",
    resultsDir: "C:/runs/review-1",
    leaf: "icons",
    model: "glm-5.2:cloud",
    effort: null,
    domain: "godot",
    grades: { adherence: 9, handoff: 6, truthfulness: 8, depth: 7, geometry: 8 },
    outcome: "completed",
    note: "",
    assessedBy: { session: "abc123", date: "2026-08-23" },
    mechanical: { ok: true, exit: 0, durationMs: 41000, tokens: 12000, costUsd: null, numTurns: 6, schemaRetried: false, citations: null },
    declared: { capabilities: ["tools"], contextLength: 1000000, parameterCount: 756162687872 },
    ...over,
  };
}

// ── validateRow ───────────────────────────────────────────────────────────────

test("validateRow: a fully-populated row passes", () => {
  deepEqual(validateRow(row()), []);
});

test("validateRow: a row with every capability aspect absent passes", () => {
  deepEqual(validateRow(row({ grades: { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 } })), []);
});

test("validateRow: an explicit null capability aspect passes — that is the N/A case", () => {
  deepEqual(validateRow(row({ grades: { adherence: 7, handoff: 7, truthfulness: 7, depth: 7, vision: null } })), []);
});

test("validateRow: an aspect key outside the closed set is rejected", () => {
  const errs = validateRow(row({ grades: { ...row().grades, godot: 8 } }));
  ok(errs.some((e) => e.startsWith("grades.godot")), errs.join(" | "));
});

test("validateRow: a missing universal aspect is rejected", () => {
  const { adherence, ...rest } = row().grades;
  const errs = validateRow(row({ grades: rest }));
  ok(errs.some((e) => e.startsWith("grades.adherence")), errs.join(" | "));
});

// The load-bearing case: an untouched `grade --init` skeleton has every grade
// null, which a presence-only check accepts while shipping an empty row.
test("validateRow: a universal aspect present but null is rejected", () => {
  const errs = validateRow(row({ grades: { adherence: null, handoff: null, truthfulness: null, depth: null } }));
  for (const a of ["adherence", "handoff", "truthfulness", "depth"]) {
    ok(errs.some((e) => e.startsWith(`grades.${a}`)), `${a} not flagged: ${errs.join(" | ")}`);
  }
});

test("validateRow: an untouched grade --init skeleton is not appendable", () => {
  const skeleton = {
    resultsDir: "C:/runs/review-1",
    leaf: "icons",
    model: "glm-5.2:cloud",
    domain: "<lowercase ecosystem — e.g. godot, rust, images, this-repo>",
    outcome: `<${OUTCOMES.join(" | ")}>`,
    note: "",
    assessedBy: { session: "abc123", date: "2026-08-23" },
    grades: Object.fromEntries(ASPECTS.map((a) => [a, null])),
  };
  const errs = validateRow(skeleton);
  ok(errs.some((e) => e.startsWith("domain:")), errs.join(" | "));
  ok(errs.some((e) => e.startsWith("outcome:")), errs.join(" | "));
});

for (const bad of [0, 11, 7.5, "8", true]) {
  test(`validateRow: grade ${JSON.stringify(bad)} is rejected`, () => {
    const errs = validateRow(row({ grades: { ...row().grades, depth: bad } }));
    ok(errs.some((e) => e.startsWith("grades.depth")), errs.join(" | "));
  });
}

test("validateRow: an unknown outcome is rejected, and does not cascade into grade errors", () => {
  const errs = validateRow(row({ outcome: "finished" }));
  ok(errs.some((e) => e.startsWith("outcome:")), errs.join(" | "));
  ok(!errs.some((e) => e.startsWith("grades")), `cascade: ${errs.join(" | ")}`);
});

for (const outcome of ["failed", "timeout", "session-died", "not-capable"]) {
  test(`validateRow: grades present on ${outcome} are rejected — no output, no grades`, () => {
    const errs = validateRow(row({ outcome, note: "no output" }));
    ok(errs.some((e) => e.startsWith("grades:")), errs.join(" | "));
  });

  test(`validateRow: ${outcome} with no grades and a note passes`, () => {
    const { grades, ...rest } = row();
    deepEqual(validateRow({ ...rest, outcome, note: "the session died on an image read" }), []);
  });
}

for (const outcome of ["completed", "wrong"]) {
  test(`validateRow: grades absent on ${outcome} are rejected — output existed`, () => {
    const { grades, ...rest } = row();
    const errs = validateRow({ ...rest, outcome, note: "n/a" });
    ok(errs.some((e) => e.startsWith("grades:")), errs.join(" | "));
  });
}

// Padding passed the lowercase check while `aggregate` filters on `===`, so a
// stored " godot " would match no query and never raise anything.
test("validateRow: a whitespace-padded domain is rejected, not silently stored", () => {
  const errs = validateRow(row({ domain: " godot " }));
  ok(errs.some((e) => e.startsWith("domain")), errs.join(" | "));
  deepEqual(aggregate([row({ domain: " godot ", note: "x" })], { aspect: "depth", domain: "godot" }).aspects[0].cells, []);
});

// A domain is ONE token naming the ecosystem. The store had 370 "this-repo" rows
// (the skeleton hint's own example) and composites like "rust+plans" that no
// query decomposes (operator, 2026-09-05).
for (const bad of ["Godot", "", "   ", undefined, "this-repo", "this repo", "rust+plans", "plans+rust", "web-research/test-architecture", "repo", "general", "misc"]) {
  test(`validateRow: domain ${JSON.stringify(bad)} is rejected`, () => {
    const errs = validateRow(row({ domain: bad }));
    ok(errs.some((e) => e.startsWith("domain")), errs.join(" | "));
  });
}

// Superseded by "Claude tiers are accepted" below (grade-claude-tiers,
// 2026-08-31): Claude models are now in scope; the junk-string rejection
// this test also carried lives in that case's not-a-model assertion.

test("validateRow: a grade <= 4 with no note is rejected", () => {
  const errs = validateRow(row({ grades: { ...row().grades, depth: 4 } }));
  ok(errs.some((e) => e.startsWith("note:")), errs.join(" | "));
  deepEqual(validateRow(row({ grades: { ...row().grades, depth: 4 }, note: "shallow — restated the prompt" })), []);
});

test("validateRow: outcome other than completed with no note is rejected", () => {
  const errs = validateRow(row({ outcome: "wrong" }));
  ok(errs.some((e) => e.startsWith("note:")), errs.join(" | "));
});

test("validateRow: a row with no resultsDir is rejected — it cannot be deduped", () => {
  const errs = validateRow(row({ resultsDir: undefined }));
  ok(errs.some((e) => e.startsWith("resultsDir:")), errs.join(" | "));
});

test("validateRow: a row with no assessedBy.session is rejected", () => {
  ok(validateRow(row({ assessedBy: {} })).some((e) => e.startsWith("assessedBy.session")));
  ok(validateRow(row({ assessedBy: undefined })).some((e) => e.startsWith("assessedBy.session")));
});

// ── appendRows ────────────────────────────────────────────────────────────────

test("appendRows: one invalid row in a batch writes nothing and leaves the file byte-identical", () => {
  const dir = tmp();
  try {
    const p = join(dir, "model-scores.jsonl");
    appendRows([row({ leaf: "a" })], p);
    const before = readFileSync(p);
    const batch = [row({ leaf: "b" }), row({ leaf: "c" }), row({ leaf: "d", outcome: "nope" }), row({ leaf: "e" }), row({ leaf: "f" })];
    throws(() => appendRows(batch, p), /refusing to append 5 row\(s\)/);
    ok(before.equals(readFileSync(p)), "the store changed despite a rejected batch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendRows: a valid batch appends exactly N lines, each parsing on its own", () => {
  const dir = tmp();
  try {
    const p = join(dir, "model-scores.jsonl");
    equal(appendRows([row({ leaf: "a" }), row({ leaf: "b" }), row({ leaf: "c" })], p), 3);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    equal(lines.length, 3);
    for (const l of lines) JSON.parse(l);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendRows: creates a missing file, and a second append neither truncates nor duplicates", () => {
  const dir = tmp();
  try {
    const p = join(dir, "nested", "model-scores.jsonl");
    ok(!existsSync(p));
    appendRows([row({ leaf: "a" })], p);
    appendRows([row({ leaf: "b" })], p);
    equal(readRows(p).length, 2);
    deepEqual(readRows(p).map((r) => r.leaf), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendRows: an empty batch is an error, not a silent no-op", () => {
  throws(() => appendRows([], join(tmpdir(), "never-written.jsonl")), /no rows to append/);
});

test("readRows: a torn tail line is skipped rather than aborting the query", () => {
  const dir = tmp();
  try {
    const p = join(dir, "model-scores.jsonl");
    appendRows([row({ leaf: "a" }), row({ leaf: "b" })], p);
    appendFileSync(p, `{"leaf":"torn"${String.fromCharCode(10)}`);
    equal(readRows(p).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dedupeKey / re-grading ────────────────────────────────────────────────────

test("dedupeKey: (resultsDir, leaf); distinct leaves and distinct runs are distinct keys", () => {
  equal(dedupeKey(row()), JSON.stringify(["C:/runs/review-1", "icons"]));
  ok(dedupeKey(row({ leaf: "other" })) !== dedupeKey(row()));
  ok(dedupeKey(row({ resultsDir: "C:/runs/review-2" })) !== dedupeKey(row()));
});

test("re-grading a run replaces its rows: aggregate reports n=1, newest wins", () => {
  const first = row({ grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 }, note: "poor" });
  const second = row({ grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } });
  const cell = aggregate([first, second], { aspect: "adherence" }).aspects[0].cells[0];
  equal(cell.n, 1);
  equal(cell.mean, 9);
  equal(dedupe([first, second]).length, 1);
});

// ── aggregate ─────────────────────────────────────────────────────────────────

const graded = (over) => row({ note: "x", ...over });

test("aggregate: a null capability grade is not counted in n", () => {
  const rows = Array.from({ length: 10 }, (_, i) => graded({
    leaf: `l${i}`,
    grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8, vision: null },
  }));
  const vision = aggregate(rows, { aspect: "vision" }).aspects[0];
  equal(vision.cells.length, 0, "a never-stressed aspect must not report ten graded leaves");
  const adherence = aggregate(rows, { aspect: "adherence" }).aspects[0].cells[0];
  equal(adherence.n, 10);
});

test("aggregate: n < 5 is provisional, n >= 5 is not", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => graded({ leaf: `l${i}` }));
  equal(aggregate(mk(4), { aspect: "depth" }).aspects[0].cells[0].provisional, true);
  equal(aggregate(mk(5), { aspect: "depth" }).aspects[0].cells[0].provisional, false);
});

test("aggregate: a no-output row never touches a mean, and stays visible under outcomes", () => {
  const rows = Array.from({ length: 10 }, (_, i) => graded({
    leaf: `l${i}`, grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 },
  }));
  const { grades, ...dead } = row();
  rows.push({ ...dead, leaf: "dead", outcome: "session-died", note: "died on an image read" });
  const cell = aggregate(rows, { aspect: "adherence" }).aspects[0].cells[0];
  equal(cell.n, 10);
  equal(cell.mean, 8);
  equal(cell.outcomes["session-died"], 1);
  equal(cell.outcomes.completed, 10);
});

test("aggregate: outcomes carry a zero entry for every outcome, so absence is visible", () => {
  const cell = aggregate([graded()], { aspect: "depth" }).aspects[0].cells[0];
  deepEqual(Object.keys(cell.outcomes), OUTCOMES);
  equal(cell.outcomes["session-died"], 0);
  equal(cell.outcomes["not-capable"], 0);
});

test("aggregate: the domain filter narrows, and an unmatched domain returns no cells", () => {
  const rows = [graded({ leaf: "a", domain: "godot" }), graded({ leaf: "b", domain: "rust" })];
  equal(aggregate(rows, { aspect: "depth", domain: "godot" }).aspects[0].cells[0].n, 1);
  deepEqual(aggregate(rows, { aspect: "depth", domain: "nosuch" }).aspects[0].cells, []);
});

test("aggregate: the model filter narrows to one model", () => {
  const rows = [graded({ leaf: "a" }), graded({ leaf: "b", model: "kimi-k2.7-code:cloud" })];
  const cells = aggregate(rows, { aspect: "depth", model: "kimi-k2.7-code:cloud" }).aspects[0].cells;
  equal(cells.length, 1);
  equal(cells[0].model, "kimi-k2.7-code:cloud");
});

test("aggregate: every aspect gets an entry even with no rows — absence is evidence", () => {
  const report = aggregate([]);
  deepEqual(report.aspects.map((a) => a.aspect), ASPECTS);
  for (const a of report.aspects) deepEqual(a.cells, []);
});

test("aggregate: an unknown aspect throws, naming the valid set", () => {
  throws(() => aggregate([], { aspect: "godot" }), /unknown aspect/);
});

// ── shrinkage ─────────────────────────────────────────────────────────────────

// The operator's case: Kimi dispatched once, GLM forty-five times. Unweighted,
// Kimi's single 9 heads the table two points clear of GLM's forty-five 7s.
function lopsided() {
  const rows = [];
  for (let i = 0; i < 45; i++) {
    rows.push(graded({ leaf: `g${i}`, model: "glm-5.2:cloud", grades: { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 } }));
  }
  rows.push(graded({ leaf: "k0", model: "kimi-k2.7-code:cloud", grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9 } }));
  for (let i = 0; i < 8; i++) {
    rows.push(graded({ leaf: `d${i}`, model: "deepseek-v4-pro:cloud", grades: { adherence: 6, handoff: 6, truthfulness: 6, depth: 6 } }));
  }
  return rows;
}

test("shrink: a thin cell is pulled toward the prior, a thick one barely moves", () => {
  equal(shrink(9, 1, 7.5), 7.75);
  equal(shrink(7, 45, 7.5), 7.05);
  equal(shrink(8, 0, 7.5), 7.5);   // no evidence at all → the prior
  equal(shrink(null, 0, 7.5), null);
  equal(shrink(9, 1, null), 9);    // no prior to shrink toward → unchanged
});

// The load-bearing fairness property. A row-weighted prior IS the busiest
// model's mean, so shrinking a rare model toward it drags it toward its most-
// dispatched rival — the exact usage bias the store exists to remove.
test("fairPrior: one model one vote — dispatch frequency cannot move the prior", () => {
  const cells = [
    { model: "glm", n: 45, mean: 7 },
    { model: "kimi", n: 1, mean: 9 },
    { model: "deepseek", n: 8, mean: 6.5 },
  ];
  equal(fairPrior(cells), 7.5);                       // (7 + 9 + 6.5) / 3
  ok(Math.abs(fairPrior(cells) - 6.96) > 0.5, "prior collapsed onto the row-weighted mean");
  // The same three models, GLM now dispatched 500 times: the prior must not move.
  equal(fairPrior([{ model: "glm", n: 500, mean: 7 }, ...cells.slice(1)]), 7.5);
});

test("fairPrior: null when nothing has been graded", () => {
  equal(fairPrior([]), null);
  equal(fairPrior([{ model: "glm", n: 0, mean: null }]), null);
});

test("aggregate: a one-sample cell no longer outranks a forty-five-sample cell by two points", () => {
  const cells = aggregate(lopsided(), { aspect: "adherence" }).aspects[0].cells;
  const kimi = cells.find((c) => c.model === "kimi-k2.7-code:cloud");
  const glm = cells.find((c) => c.model === "glm-5.2:cloud");
  equal(kimi.mean, 9);          // the raw evidence is untouched and still shown
  equal(glm.mean, 7);
  ok(kimi.mean - glm.mean === 2, "raw means changed");
  ok(kimi.weighted - glm.weighted < 1, `gap not narrowed: ${kimi.weighted} vs ${glm.weighted}`);
  ok(kimi.weighted > glm.weighted, "a rare model was penalised into second place for being rare");
});

test("aggregate: cells rank on weighted, not raw mean", () => {
  const { cells } = aggregate(lopsided(), { aspect: "adherence" }).aspects[0];
  const scores = cells.map((c) => c.weighted);
  deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("aggregate: the prior is reported so the shrinkage is auditable", () => {
  const a = aggregate(lopsided(), { aspect: "adherence" }).aspects[0];
  equal(a.prior, fairPrior(a.cells));
  equal(a.prior, (7 + 9 + 6) / 3);
});

test("aggregate: pure — equal results on repeat, input untouched", () => {
  const rows = [graded({ leaf: "a" }), graded({ leaf: "b" })];
  const snapshot = JSON.stringify(rows);
  const first = aggregate(rows, { aspect: "depth" });
  const second = aggregate(rows, { aspect: "depth" });
  deepEqual(first, second);
  equal(JSON.stringify(rows), snapshot);
});

test("scoresPath: derives from SWARM_HOME, never a hardcoded home", () => {
  match(scoresPath({ SWARM_HOME: join("C:", "custom") }), /custom[\\/]model-scores\.jsonl$/);
});

// --- Claude tiers are gradeable (grade-claude-tiers) --------------------
// Red input: the old validator rejected any non-:cloud model with
// "out of scope". A baseline row whose model is a Claude tier must pass;
// a junk model name must still fail (two families, not any string).
test("validateRow: Claude tiers are accepted, junk models are not", () => {
  for (const model of ["sonnet", "claude-haiku-4-5-20251001"]) {
    deepEqual(validateRow(row({ model })), []);
  }
  const errs = validateRow(row({ model: "not-a-model" }));
  ok(errs.some((e) => e.startsWith("model:")), String(errs));
});

// ── overall ──────────────────────────────────────────────────────────────────
// Red input: overall() must rank models by the mean of their four UNIVERSAL
// weighted scores — the single-table ranking perf lacked. A capability grade
// (geometry 2 below) must NOT drag the combined score.
test("overall: one table, combined = mean of universal weighted, capabilities excluded", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row({ resultsDir: `C:/runs/a-${i}`, model: "strong:cloud",
      grades: { adherence: 9, handoff: 9, truthfulness: 9, depth: 9, geometry: 2 } }));
    rows.push(row({ resultsDir: `C:/runs/b-${i}`, model: "weak:cloud",
      grades: { adherence: 6, handoff: 6, truthfulness: 6, depth: 6 } }));
  }
  const o = overall(rows, {});
  deepEqual(o.cells.map((c) => c.model), ["strong:cloud", "weak:cloud"]);
  // combined must equal the mean of the same four weighted values aggregate reports
  const agg = aggregate(rows, {});
  for (const cell of o.cells) {
    const wtds = agg.aspects.filter((a) => a.universal)
      .map((a) => a.cells.find((c) => c.model === cell.model).weighted);
    equal(cell.combined, Number((wtds.reduce((x, y) => x + y, 0) / wtds.length).toFixed(2)));
    equal(cell.n, 6);
  }
  // geometry 2 must not appear anywhere in the combined maths
  ok(o.cells[0].combined > 8, "capability grade leaked into the combined score");
});

test("overall: an outcomes-only model has combined null and sorts last", () => {
  const rows = [
    row({ resultsDir: "C:/runs/x-1" }),
    { ...row({ resultsDir: "C:/runs/y-1", model: "dead:cloud", outcome: "failed",
        note: "died" }), grades: undefined },
  ];
  const o = overall(rows, {});
  equal(o.cells.at(-1).model, "dead:cloud");
  equal(o.cells.at(-1).combined, null);
});
