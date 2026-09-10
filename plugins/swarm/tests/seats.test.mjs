import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { seatReport } from "../src/seats.mjs";
import { overall, aggregate, frontier } from "../src/scores.mjs";

// The same baseline store row scores.test.mjs builds — one field mutated per
// case, so a failure names what it is about.
function row(over = {}) {
  return {
    ts: "2026-09-10T10:00:00Z",
    resultsDir: "C:/runs/review-1",
    leaf: "icons",
    model: "glm-5.2:cloud",
    effort: null,
    domain: "node",
    grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 },
    outcome: "completed",
    note: "",
    assessedBy: { session: "abc123", date: "2026-09-10" },
    ...over,
  };
}

const graded = (over) => row({ note: "x", ...over });

const lineOf = (out, model) =>
  out.split("\n").find((l) => l.startsWith(`  ${model} (`));

test("seatReport: one row per distinct seated model, naming all its leaf ids", () => {
  const models = [
    { model: "a:cloud", leaves: ["scan", "fix-a", "fix-b"] },
    { model: "b:cloud", leaves: ["audit"] },
    { model: "haiku", leaves: ["digest"] },
  ];
  const rows = [
    graded({ leaf: "x" }),
    graded({ leaf: "y", model: "b:cloud" }),
    graded({ leaf: "z", model: "haiku" }),
  ];
  const out = seatReport({ models, rows, costRows: [], roster: [] }).join("\n");
  // RED guard: a per-LEAF row prints a:cloud three times.
  for (const m of models) {
    equal(out.split("\n").filter((l) => l.startsWith(`  ${m.model} (`)).length, 1, `${m.model} must be exactly one row:\n${out}`);
  }
  const line = lineOf(out, "a:cloud");
  for (const leaf of ["scan", "fix-a", "fix-b"]) ok(line.includes(leaf), line);
});

test("seatReport: n, weighted, cost band and verdict match what scores.mjs and cost.mjs return", () => {
  const leaves = (model, g, n) => Array.from({ length: n }, (_, i) => graded({
    resultsDir: `C:/runs/${model}-${i}`,
    model,
    grades: { adherence: g, handoff: g, truthfulness: g, depth: g, impl: g, code: g },
  }));
  const rows = [...leaves("dear:cloud", 7, 24), ...leaves("cheap:cloud", 9, 24)];
  const costRows = [{ model: "dear:cloud", mult: 4.0 }, { model: "cheap:cloud", mult: 1.0 }];
  const out = seatReport({
    models: [{ model: "dear:cloud", leaves: ["lane"] }],
    rows,
    costRows,
    roster: [{ model: "cheap:cloud" }],
  }).join("\n");

  // Expected values come from the source functions — a literal here would pin
  // a copy, and the copy is what drifts.
  const o = overall(rows).cells.find((c) => c.model === "dear:cloud");
  const impl = aggregate(rows, { aspect: "impl" }).aspects[0].cells.find((c) => c.model === "dear:cloud");
  const code = aggregate(rows, { aspect: "code" }).aspects[0].cells.find((c) => c.model === "dear:cloud");
  const f = frontier(rows, costRows, {}).find((e) => e.model === "dear:cloud");

  const line = lineOf(out, "dear:cloud");
  ok(line.includes(`overall ${o.combined.toFixed(2)} n=${o.n}`), line);
  ok(line.includes(`impl ${impl.weighted.toFixed(2)} n=${impl.n}`), line);
  ok(line.includes(`code ${code.weighted.toFixed(2)} n=${code.n}`), line);
  ok(line.includes(`cost ${"$".repeat(f.band)}`), line);
  ok(line.includes(`dominated by ${f.dominatedBy}`), line);
  // the dominator is unseated, so D3 must surface it in the roster line
  ok(out.includes("launchable, not seated:"), out);
  ok(out.includes("cheap:cloud n="), out);
});

test("seatReport: a never-graded model reads never graded, never a zero or a dash", () => {
  const rows = [graded({ leaf: "a" })]; // someone is graded; ghost is not
  const lines = seatReport({
    models: [{ model: "ghost:cloud", leaves: ["probe"] }, { model: "glm-5.2:cloud", leaves: ["lane"] }],
    rows,
    costRows: [],
    roster: [],
  });
  const out = lines.join("\n");
  const line = lineOf(out, "ghost:cloud");
  ok(line.includes("never graded"), line);
  // The inversion this row exists for: an unmeasured model through the numeric
  // path prints 0.00 / n=0 / —, which reads as terrible when it means unknown.
  ok(!line.includes("0.00"), line);
  ok(!/\b0\b/.test(line), `a bare 0 reads as a score: ${line}`);
  ok(!/\d/.test(line), `digits on a never-graded row read as measurements: ${line}`);
  // this block renders unmeasured as words everywhere — a dash is perf's
  // unmeasured glyph, and here it would sit where a score goes.
  ok(!out.includes("—"), out);
});

test("seatReport: rows but no cost entry reads unmeasured, never 0x or free", () => {
  const rows = [graded({ leaf: "a", model: "half:cloud" })];
  for (const costRows of [[], [{ model: "half:cloud", mult: null }]]) {
    const out = seatReport({
      models: [{ model: "half:cloud", leaves: ["lane"] }],
      rows,
      costRows,
      roster: [],
    }).join("\n");
    const line = lineOf(out, "half:cloud");
    ok(line.includes("cost unmeasured"), `with costRows=${JSON.stringify(costRows)}: ${line}`);
    ok(!/0(\.0)?[x×]/i.test(line), `a zero cost reads as free: ${line}`);
    ok(!/free/i.test(line), line);
  }
});

test("seatReport: n<20 marks under-canon columns; n=20 is unmarked — both sides pinned", () => {
  const leaves = (model, n) => Array.from({ length: n }, (_, i) => graded({
    resultsDir: `C:/runs/${model}-${i}`,
    model,
  }));
  const rows = [...leaves("thin:cloud", 19), ...leaves("canon:cloud", 20)];
  const out = seatReport({
    models: [{ model: "thin:cloud", leaves: ["l"] }, { model: "canon:cloud", leaves: ["l"] }],
    rows,
    costRows: [],
    roster: [],
  }).join("\n");
  ok(lineOf(out, "thin:cloud").includes("n<20"), lineOf(out, "thin:cloud"));
  ok(!lineOf(out, "canon:cloud").includes("n<20"), `n=20 is at canon and must not be marked: ${lineOf(out, "canon:cloud")}`);
});

test("seatReport: launchable-but-unseated models list with their n; a seated model never double-lists", () => {
  const rows = [
    graded({ leaf: "s1", model: "seated:cloud" }),
    ...Array.from({ length: 7 }, (_, i) => graded({ resultsDir: `C:/runs/o-${i}`, leaf: "o", model: "outsider:cloud" })),
  ];
  const out = seatReport({
    models: [{ model: "seated:cloud", leaves: ["lane"] }],
    rows,
    costRows: [],
    roster: [{ model: "seated:cloud" }, { model: "outsider:cloud" }, { model: "unproven:cloud" }],
  }).join("\n");
  const tail = out.split("\n").find((l) => l.startsWith("  launchable, not seated:"));
  ok(tail.includes("outsider:cloud n=7"), tail);
  ok(tail.includes("unproven:cloud never graded"), tail);
  ok(!tail.includes("seated:cloud"), `the seated model is listed twice: ${tail}`);
});

// The observed incident: kimi seated on an implementation lane at n=24 while
// glm-5.3-flash — same band, strictly better and cheaper, and NOT seated —
// dominates it. The block states that record and editorialises nothing: the
// seating rule prefers an under-canon model in a common case, so a bad-seat
// warning would fire on correct seats and be ignored on real ones.
test("seatReport: a poor seat is stated, never judged", () => {
  const leaves = (model, g, n) => Array.from({ length: n }, (_, i) => graded({
    resultsDir: `C:/runs/${model}-${i}`,
    model,
    grades: { adherence: g, handoff: g, truthfulness: g, depth: g, impl: g, code: g },
  }));
  const rows = [...leaves("kimi-k2.7-code:cloud", 7, 24), ...leaves("glm-5.3-flash:cloud", 8, 24)];
  const out = seatReport({
    models: [{ model: "kimi-k2.7-code:cloud", leaves: ["impl-lane"] }],
    rows,
    costRows: [{ model: "kimi-k2.7-code:cloud", mult: 4.0 }, { model: "glm-5.3-flash:cloud", mult: 3.5 }],
    roster: [{ model: "glm-5.3-flash:cloud" }, { model: "fresh:cloud" }],
  }).join("\n");
  ok(out.includes("dominated by glm-5.3-flash:cloud"), out);
  const lower = out.toLowerCase();
  for (const word of ["warn", "warning", "should", "instead", "wrong"]) {
    ok(!lower.includes(word), `${word} is a judgement, and the block does not judge: ${out}`);
  }
  ok(!out.includes("!"), out);
});

test("seatReport: an empty store or nothing seated prints nothing at all", () => {
  deepEqual(seatReport({ models: [{ model: "a:cloud", leaves: ["x"] }], rows: [], costRows: [], roster: [] }), []);
  deepEqual(seatReport({ models: [], rows: [graded({})], costRows: [], roster: [] }), []);
  deepEqual(seatReport({ rows: [graded({})] }), []);
});

test("seatReport: pure — inputs untouched, equal output on repeat", () => {
  const models = [{ model: "a:cloud", leaves: ["x"] }];
  const rows = [graded({ leaf: "a", model: "a:cloud" })];
  const costRows = [{ model: "a:cloud", mult: 1.2 }];
  const roster = [{ model: "b:cloud" }];
  const before = JSON.stringify({ models, rows, costRows, roster });
  const first = seatReport({ models, rows, costRows, roster });
  const second = seatReport({ models, rows, costRows, roster });
  deepEqual(first, second);
  equal(JSON.stringify({ models, rows, costRows, roster }), before, "the inputs were mutated");
});