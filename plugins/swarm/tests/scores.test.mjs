import { test } from "node:test";
import { equal, deepEqual, ok, throws, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateRow, dedupeKey, dedupe, appendRows, readRows, aggregate, overall, scoresPath, shrink, fairPrior, PRIOR_WEIGHT, frontier, canonicalRunKey, gradedRunKeys,
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

// ── frontier: domination, never a ratio ──────────────────────────────────────
// Test 5's table: quality order A > D > B > C with multipliers A 4.4x, B 1.0x,
// C 1.9x, D 20.3x — plus E, one graded leaf at a tiny 0.5x. Integer grades and
// shrinkage move the exact wtd values off the plan's illustrative numbers, but
// every relationship the table encodes holds exactly.

const frontierLeaves = (model, g, n) =>
  Array.from({ length: n }, (_, i) => graded({
    resultsDir: `C:/runs/frontier-${model}-${i}`,
    model,
    grades: { adherence: g, handoff: g, truthfulness: g, depth: g },
  }));

test("frontier: 5 — the frontier is domination, not a ratio", () => {
  const rows = [
    ...frontierLeaves("a:cloud", 10, 5),
    ...frontierLeaves("d:cloud", 9, 5),
    ...frontierLeaves("b:cloud", 8, 5),
    ...frontierLeaves("c:cloud", 7, 5),
    ...frontierLeaves("e:cloud", 7, 1), // one graded leaf, tiny multiplier
  ];
  const costs = [
    { model: "a:cloud", mult: 4.4 },
    { model: "b:cloud", mult: 1.0 },
    { model: "c:cloud", mult: 1.9 },
    { model: "d:cloud", mult: 20.3 },
    { model: "e:cloud", mult: 0.5 },
  ];
  const v = frontier(rows, costs, {});
  // aggregate order: quality-desc. RED: a quality÷cost ratio heads the list
  // with e (8.0 wtd / 0.5x) — the historical failure cost-table's SKILL.md
  // records as "it once put a model with one graded leaf on top".
  deepEqual(v.map((x) => x.model), ["a:cloud", "d:cloud", "b:cloud", "e:cloud", "c:cloud"],
    "RED: the ratio ordering heads the list with the one-leaf cheap model");
  const by = Object.fromEntries(v.map((x) => [x.model, x]));
  ok(by["a:cloud"].onFrontier, "the best model is on the frontier even though it is not cheap");
  ok(by["b:cloud"].onFrontier, "b stays on the frontier despite e being cheaper — e's quality (8.0) is below b's (8.1)");
  ok(by["e:cloud"].onFrontier, "the cheapest model is on the frontier regardless of quality");
  equal(by["c:cloud"].dominatedBy, "b:cloud", "c is both worse and dearer than b");
  equal(by["d:cloud"].dominatedBy, "a:cloud",
    "RED for both naive rules: d outscores b so cheapest-wins keeps it, and a ratio ranks it last while still listing it — only a, better AND cheaper, dominates it");
  equal(by["d:cloud"].onFrontier, false);
  equal(by["a:cloud"].band, 2, "4.4x sits in the 2..5 mid band");
  equal(by["d:cloud"].band, 3);
  equal(by["e:cloud"].band, 1);
});

// Test 6 — a Claude tier has quality but no multiplier: the history has never
// priced it. Absence is not evidence in either direction — not 0 (free, and so
// dominating everything) and not Infinity (dear, and so dominated by everything).
test("frontier: 6 — Claude tiers are unmeasured, not dominated", () => {
  const rows = [
    ...frontierLeaves("sonnet", 9, 5),
    ...frontierLeaves("a:cloud", 8, 5),
    ...frontierLeaves("b:cloud", 7, 5),
  ];
  const costs = [
    { model: "a:cloud", mult: 1.0 },
    { model: "b:cloud", mult: 2.0 },
  ]; // sonnet deliberately absent — nothing has measured it
  const v = frontier(rows, costs, { aspect: "depth" });
  equal(v[0].model, "sonnet", "unmeasured models stay listed, in quality order, marked —");
  const by = Object.fromEntries(v.map((x) => [x.model, x]));
  equal(by.sonnet.multiplier, null, "RED: a missing multiplier was fabricated as 0 — the tier read as free");
  equal(by.sonnet.onFrontier, false, "RED: a missing multiplier read as Infinity put the tier on the frontier");
  equal(by.sonnet.dominatedBy, null, "RED: a missing multiplier read as Infinity marked the tier dominated by everything");
  ok(!v.some((x) => x.dominatedBy === "sonnet"), "RED: a missing multiplier read as 0 let the unmeasured tier dominate everything");
  // the measured models' verdicts are exactly what they would be without sonnet
  ok(by["a:cloud"].onFrontier);
  equal(by["b:cloud"].dominatedBy, "a:cloud");
});

test("frontier: a single measured model is on the frontier", () => {
  const v = frontier(frontierLeaves("solo:cloud", 8, 6), [{ model: "solo:cloud", mult: 1.9 }], { aspect: "depth" });
  equal(v.length, 1);
  ok(v[0].onFrontier);
  equal(v[0].dominatedBy, null);
  equal(v[0].multiplier, 1.9);
  equal(v[0].band, 1);
});

// A measured-but-thin model carries mult: null from multipliers() — it is
// unmeasured for the frontier too, never free.
test("frontier: a thin model's null multiplier is unmeasured, not free", () => {
  const rows = [...frontierLeaves("a:cloud", 8, 5), ...frontierLeaves("thin:cloud", 9, 5)];
  const v = frontier(rows, [
    { model: "a:cloud", mult: 1.0 },
    { model: "thin:cloud", mult: null },
  ], { aspect: "depth" });
  const by = Object.fromEntries(v.map((x) => [x.model, x]));
  equal(by["thin:cloud"].multiplier, null, "RED: the thin model's null multiplier was read as 0");
  equal(by["thin:cloud"].onFrontier, false, "RED: fabricated-free thin model joined the frontier");
  equal(by["thin:cloud"].dominatedBy, null);
  ok(by["a:cloud"].onFrontier);
});

test("frontier: no measured multipliers at all — the frontier is empty, nothing crashes", () => {
  const rows = [...frontierLeaves("a:cloud", 8, 5), ...frontierLeaves("b:cloud", 7, 5)];
  for (const costs of [[], null]) {
    const v = frontier(rows, costs, { aspect: "depth" });
    equal(v.length, 2);
    ok(!v.some((x) => x.onFrontier), "absence of measurement is not evidence of being free");
    for (const x of v) {
      equal(x.multiplier, null);
      equal(x.dominatedBy, null);
      equal(x.band, null);
    }
  }
});

test("frontier: pure — inputs untouched, equal output on repeat", () => {
  const rows = [
    ...frontierLeaves("a:cloud", 10, 5),
    ...frontierLeaves("b:cloud", 7, 5),
  ];
  const costs = [{ model: "a:cloud", mult: 4.4 }, { model: "b:cloud", mult: 1.0 }];
  const before = JSON.stringify({ rows, costs });
  const first = frontier(rows, costs, {});
  const second = frontier(rows, costs, {});
  deepEqual(first, second);
  equal(JSON.stringify({ rows, costs }), before, "the inputs were mutated");
});

// ── canonicalRunKey / gradedRunKeys: graded-ness against a canonical key ──────
// The blocker's guard. The store's rows and the runs-tree walk name the same
// dirs in different spellings; graded-ness must survive the difference or
// every graded run reads ungraded forever.

test("canonicalRunKey: separator, case and trailing-separator differences fold to one key", () => {
  equal(canonicalRunKey("C:\\Users\\a\\.swarm\\runs\\x-1"), canonicalRunKey("C:/Users/a/.swarm/runs/x-1"));
  equal(canonicalRunKey("C:/Users/a/.SWARM/runs/X-1"), canonicalRunKey("c:/users/a/.swarm/runs/x-1"));
  equal(canonicalRunKey("C:/Users/a/.swarm/runs/x-1/"), canonicalRunKey("C:/Users/a/.swarm/runs/x-1"));
  equal(canonicalRunKey("C:/Users/a/.swarm/runs/x-1//"), canonicalRunKey("C:\\Users\\a\\.swarm\\runs\\x-1\\"));
});

test("gradedRunKeys: a forward-slash store row is found by a backslash walk path — raw comparison finds none of them", () => {
  const storeRow = row({ resultsDir: "C:/Users/a/.swarm/runs/x-1" }); // forward slashes, as 349 of 355 real rows are
  const walkPath = "C:\\Users\\a\\.swarm\\runs\\x-1";                 // what readdirSync + path.join yields on Windows
  // The shipped design's failure, pinned: exact-string membership misses the row.
  ok(!new Set([storeRow.resultsDir]).has(walkPath), "raw comparison somehow matched — the blocker is gone, revisit");
  ok(gradedRunKeys([storeRow]).has(canonicalRunKey(walkPath)), "the canonical key must find the forward-slash row");
});

test("gradedRunKeys: a resultsDir that will not canonicalise is skipped, never matched to something", () => {
  equal(canonicalRunKey("."), null);
  equal(canonicalRunKey(""), null);
  equal(canonicalRunKey(undefined), null);
  equal(canonicalRunKey(42), null);
  const keys = gradedRunKeys([row({ resultsDir: "." }), row({ resultsDir: "" }), row({ resultsDir: "C:/runs/real-1" })]);
  deepEqual([...keys], [canonicalRunKey("C:/runs/real-1")]);
});

test("gradedRunKeys: a re-graded (superseded) dir still counts as graded — any row names the dir", () => {
  const first = row({ resultsDir: "C:/runs/review-1", leaf: "a", grades: { adherence: 3, handoff: 3, truthfulness: 3, depth: 3 }, note: "poor" });
  const second = row({ resultsDir: "C:/runs/review-1", leaf: "a" }); // the re-grade: same (dir, leaf) dedupe key
  const keys = gradedRunKeys([first, second]);
  equal(keys.size, 1);
  ok(keys.has(canonicalRunKey("C:/runs/review-1")));
});
