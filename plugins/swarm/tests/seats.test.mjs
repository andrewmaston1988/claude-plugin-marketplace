import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { seatReport, resolveSeatModel, gapCandidates } from "../src/seats.mjs";
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
  // seated:cloud is itself under canon and seated, so the exploration seat is
  // already taken — the gap line would name a model nobody is being asked for.
  ok(!out.includes("gap seat available"), out);
});

// ── the gap seat: what makes an ungraded model get seated ───────────────────
// An ungraded model is absent from the ranking the author reads to seat, so
// nothing in the output asks for it. Validate names one available seat, with
// the reason to take it, in the block every dispatch already passes through.
const many = (model, g, n) => Array.from({ length: n }, (_, i) => graded({
  resultsDir: `C:/runs/${model}-${i}`,
  model,
  grades: { adherence: g, handoff: g, truthfulness: g, depth: g, impl: g, code: g },
}));
const priced = (model, mult) => ({
  model, mult, requests: 300, measuredRequests: 300, weeks: 1, measuredWeeks: 1,
  unit: "usd", costDomain: "ollama:usd:meter",
});

test("seatReport: a gap seat is named when nothing seated is under canon", () => {
  const rows = many("kimi-k2.6:cloud", 8, 24);
  const seated = { model: "kimi-k2.6:cloud", leaves: ["impl-lane"] };
  const roster = [seated, { model: "fresh:cloud" }];
  const out = seatReport({ models: [seated], rows, costRows: [], roster }).join("\n");
  const gap = out.split("\n").find((l) => l.startsWith("  gap seat available:"));
  ok(gap.includes("fresh:cloud (never graded)"), out);
  ok(gap.includes("needs grades, n=0"), gap);
  ok(gap.includes("seat it on one bounded leaf this run"), `the line carries its own instruction, so no skill has to: ${gap}`);

  // A run that already seats the gap model is not nudged twice.
  const seatedGap = seatReport({ models: [{ model: "fresh:cloud", leaves: ["probe"] }], rows, costRows: [], roster }).join("\n");
  ok(!seatedGap.includes("gap seat available"), seatedGap);
  // Nothing launchable outside the seats: nothing to name.
  const noneLeft = seatReport({ models: [seated], rows, costRows: [], roster: [seated] }).join("\n");
  ok(!noneLeft.includes("gap seat available"), noneLeft);
});

// The strongest case first: a successor of a best-value elder, then of a
// frontier one, then whatever is left. The elder's own row is the source —
// its rank and its verdict, never a guess about the model that has no grades.
test("gapCandidates: sells the successor of the best-value elder first, and the gap line carries it", () => {
  const rows = [...many("kimi-k2.6:cloud", 8.6, 24), ...many("glm-5.2:cloud", 9, 24)];
  const costRows = [priced("kimi-k2.6:cloud", 1), priced("glm-5.2:cloud", 3)];
  const seated = { model: "kimi-k2.6:cloud", leaves: ["impl-lane"] };
  const roster = [
    seated,
    { model: "kimi-k2.7-code:cloud" },
    { model: "glm-5.2:cloud" },
    { model: "glm-5.3:cloud" },
    { model: "fresh:cloud" },
  ];
  const candidates = gapCandidates({ roster, rows, costRows });

  deepEqual(candidates.map((c) => c.model), ["kimi-k2.7-code:cloud", "glm-5.3:cloud", "fresh:cloud"]);
  deepEqual(candidates.map((c) => c.elder), ["kimi-k2.6:cloud", "glm-5.2:cloud", null]);
  deepEqual(candidates[0].verdicts, ["best value"]);
  deepEqual(candidates[1].verdicts, ["frontier"]);
  equal(candidates[0].rank, 2);
  equal(candidates[1].rank, 1, "the elder's rank rides along, even when it sorts after a better pitch");
  equal(candidates[2].n, 0);

  const out = seatReport({ models: [seated], rows, costRows, roster }).join("\n");
  const gap = out.split("\n").find((l) => l.startsWith("  gap seat available:"));
  ok(gap.includes("gap seat available: kimi-k2.7-code:cloud (never graded)"), gap);
  ok(gap.includes("newer generation of kimi-k2.6:cloud (#2 overall, best value)"), gap);
  // the line replaces that model's unseated entry, and only that one's
  const tail = out.split("\n").find((l) => l.startsWith("  launchable, not seated:"));
  ok(!tail.includes("kimi-k2.7-code:cloud"), `the gap seat is named twice: ${tail}`);
  ok(tail.includes("glm-5.3:cloud never graded"), tail);
  ok(tail.includes("glm-5.2:cloud n=24"), tail);
});

test("gapCandidates: a roster model with no rows is never graded, and only under-canon models are candidates", () => {
  const rows = many("kimi-k2.6:cloud", 8, 24);
  const roster = [{ model: "kimi-k2.6:cloud" }, { model: "fresh:cloud" }];
  const candidates = gapCandidates({ roster, rows });

  deepEqual(candidates.map((c) => c.model), ["fresh:cloud"]);
  equal(candidates[0].n, 0);
  equal(candidates[0].elder, null);
  deepEqual(gapCandidates({ roster: [{ model: "kimi-k2.6:cloud" }], rows }), [], "at n=24 the model is not a gap");
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
// A manifest seats a Claude tier by alias; the store records the resolved id.
// Measured on the real store when this shipped: haiku/sonnet/opus all read
// "never graded" against 91/462/43 actual rows — the row-3 inversion one field
// over, and the one that would hand the exploration seat to the single
// best-measured model on the roster.
test("seatReport: a Claude alias finds its resolved id in the store, and says which", () => {
  const rows = [
    // Distinct leaf ids: the store dedupes on [resultsDir, leaf], so rows that
    // share both collapse to one and the fixture would silently be n=1.
    ...Array.from({ length: 30 }, (_, i) => graded({ model: "claude-sonnet-5", leaf: `s${i}` })),
    ...Array.from({ length: 4 }, (_, i) => graded({ model: "claude-opus-4-8", leaf: `o${i}` })),
    ...Array.from({ length: 9 }, (_, i) => graded({ model: "claude-opus-5", leaf: `p${i}` })),
  ];
  const out = seatReport({ models: [{ model: "sonnet", leaves: ["d"] }], rows, costRows: [], roster: [] }).join("\n");
  const line = out.split("\n").find((l) => l.includes("sonnet"));
  ok(!line.includes("never graded"), `alias must resolve, got: ${line}`);
  ok(line.includes("n=30"), `must carry the store's real n, got: ${line}`);
  ok(line.includes("sonnet -> claude-sonnet-5"), `must SHOW what it resolved to, got: ${line}`);
});

test("resolveSeatModel: an alias takes the id with the most rows; a non-alias never guesses", () => {
  const byModel = new Map([
    ["claude-opus-4-8", { n: 4 }],
    ["claude-opus-5", { n: 9 }],
    ["glm-5.3:cloud", { n: 70 }],
  ]);
  equal(resolveSeatModel("opus", byModel), "claude-opus-5", "the tier's current model is the one still being graded");
  equal(resolveSeatModel("glm-5.3:cloud", byModel), "glm-5.3:cloud", "an exact match is used as-is");
  equal(resolveSeatModel("fable", byModel), null, "an alias with no matching id resolves to nothing");
  equal(resolveSeatModel("glm-5.4:cloud", byModel), null, "a non-alias never family-matches — only the four aliases take that path");
});

// The family match is positional, not substring: a claude-provided id that
// merely CONTAINS "opus" is not the opus family. A substring test hands the
// seat to whichever claude-provided row has the most rows — an id like
// not-opus-9b out-polling the real model would seat a non-family id.
test("a claude-provided id containing a family token is not that family (substring trap)", () => {
  const byModel = new Map([
    [JSON.stringify(["claude", "not-opus-9b"]), { n: 99 }],
    [JSON.stringify(["claude", "claude-opus-5"]), { n: 3 }],
  ]);
  equal(resolveSeatModel("opus", byModel), "claude-opus-5", "family matching is positional: not-opus-9b is not the opus family");
  equal(resolveSeatModel("opus", new Map([[JSON.stringify(["claude", "not-opus-9b"]), { n: 99 }]])), null, "no real family id, no resolution");
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => graded({ provider: "claude", model: "not-opus-9b", leaf: `g${i}` })),
    graded({ provider: "claude", model: "claude-opus-5", leaf: "p0" }),
  ];
  const out = seatReport({ models: [{ model: "opus", leaves: ["d"] }], rows, costRows: [], roster: [] }).join("\n");
  ok(out.includes("opus -> claude/claude-opus-5"), `the seat must resolve to the real family id, got: ${out}`);
});

test("seatReport: an alias with genuinely no rows still reads never graded", () => {
  const rows = [graded({ model: "claude-sonnet-5" })];
  const out = seatReport({ models: [{ model: "fable", leaves: ["d"] }], rows, costRows: [], roster: [] }).join("\n");
  ok(out.includes("never graded"), `unmeasured must stay unmeasured, got: ${out}`);
  ok(!out.includes("->"), "nothing was resolved, so nothing is shown as resolved");
});

test("seatReport: the unseated roster resolves aliases too", () => {
  const rows = Array.from({ length: 12 }, (_, i) => graded({ model: "claude-haiku-4-5-20251001", leaf: `h${i}` }));
  const out = seatReport({
    models: [{ model: "glm-5.3:cloud", leaves: ["a"] }],
    rows: [...rows, graded({ model: "glm-5.3:cloud" })],
    costRows: [],
    // glm-5.3 is seated at n=1, so the exploration seat is taken and the gap
    // line stays quiet — this row is about the unseated list's own resolution.
    roster: [{ model: "glm-5.3:cloud" }, { model: "haiku" }],
  }).join("\n");
  ok(/haiku n=12 n<20/.test(out), `the unseated list must carry the alias's real n, got: ${out}`);
});

test("gapCandidates: the elder's rank is the combined-provider rank the table prints", () => {
  const under = (provider, model, g, n) => many(model, g, n).map((r) => ({ ...r, provider, resultsDir: `${r.resultsDir}-${provider}` }));
  const rows = [...under("ollama", "m-1", 9, 6), ...under("beta", "m-1", 4, 6), ...under("ollama", "m-2", 7, 6)];
  const combined = overall(rows, { combineProviders: true }).cells.map((c) => c.model);
  const candidates = gapCandidates({ roster: [{ model: "m-3" }], rows });
  const m3 = candidates.find((c) => c.model === "m-3");
  equal(m3.elder, "m-2");
  equal(m3.rank, combined.indexOf("m-2") + 1, `the table ranks ${combined.join(" > ")}`);
});

test("gapCandidates: verdicts follow the configured valueMargin, as costView's do", () => {
  const rows = [...many("kimi-k2.6:cloud", 8.6, 24), ...many("glm-5.2:cloud", 9, 24)];
  const costRows = [priced("kimi-k2.6:cloud", 1), priced("glm-5.2:cloud", 3)];
  const roster = [{ model: "kimi-k2.7-code:cloud" }, { model: "glm-5.3:cloud" }];
  const verdicts = (opts) => Object.fromEntries(gapCandidates({ roster, rows, costRows, ...opts }).map((c) => [c.elder, c.verdicts]));
  deepEqual(verdicts({}), { "kimi-k2.6:cloud": ["best value"], "glm-5.2:cloud": ["frontier"] });
  deepEqual(verdicts({ valueMargin: 0.1 }), { "kimi-k2.6:cloud": ["frontier"], "glm-5.2:cloud": ["best value"] },
    "a tight margin moves best value to the top scorer, on the dashboard and here alike");
});
