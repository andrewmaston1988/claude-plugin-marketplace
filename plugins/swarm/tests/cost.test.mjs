// Cost history — the banked weekly snapshots `swarm cost` derives multipliers
// from. Storage tests live here (line-atomic appends, torn tails); the
// derivation tests (week split, per-model cost, multipliers) are below and are
// ported field-for-field from the operator's cost-table arithmetic.
import { test } from "node:test";
import { equal, deepEqual, ok, throws, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  usageHistoryPath, appendSnapshot, readSnapshots, splitWeeks, costPerModel, multipliers, band,
  resolveBands, DEFAULT_COST_BANDS,
} from "../src/cost.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cost-"));
}

// ── storage ───────────────────────────────────────────────────────────────────

test("usageHistoryPath: derives from SWARM_HOME, never a hardcoded home", () => {
  match(usageHistoryPath({ SWARM_HOME: join("C:", "custom") }), /custom[\\/]usage-history\.jsonl$/);
});

test("appendSnapshot: creates a missing dir and appends one parseable line per snapshot", () => {
  const dir = tmp();
  try {
    const p = join(dir, "nested", "usage-history.jsonl");
    ok(!existsSync(p));
    appendSnapshot({ fetchedAt: 1, weeklyPctUsed: 40, weeklyModels: [] }, p);
    appendSnapshot({ fetchedAt: 2, weeklyPctUsed: 41, weeklyModels: [] }, p);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    equal(lines.length, 2, "two appends, two lines — one snapshot never straddles a line boundary");
    for (const l of lines) JSON.parse(l);
    equal(readSnapshots(p).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// JSON escapes real newlines, so a snapshot's string values cannot break the
// one-line-one-snapshot invariant the concurrent-append safety rests on.
test("appendSnapshot: a string value containing a newline stays one line", () => {
  const dir = tmp();
  try {
    const p = join(dir, "usage-history.jsonl");
    appendSnapshot({ fetchedAt: 1, note: "a\nb" }, p);
    equal(readSnapshots(p).length, 1);
    equal(readSnapshots(p)[0].note, "a\nb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshots: a torn tail line is skipped rather than aborting the query", () => {
  const dir = tmp();
  try {
    const p = join(dir, "usage-history.jsonl");
    appendSnapshot({ fetchedAt: 1, weeklyModels: [] }, p);
    appendSnapshot({ fetchedAt: 2, weeklyModels: [] }, p);
    appendFileSync(p, `{"fetchedAt":3${String.fromCharCode(10)}`);
    equal(readSnapshots(p).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshots: a missing file reads as empty, never throws", () => {
  deepEqual(readSnapshots(join(tmpdir(), "swarm-cost-no-such", "usage-history.jsonl")), []);
});

// ── derivation ────────────────────────────────────────────────────────────────
// Fixtures only — no test may fetch. A snapshot carries the shape
// `appendSnapshot` banks: fetchedAt, weeklyPctUsed, weeklyModels.

const snap = (fetchedAt, models, pct) => ({ fetchedAt, weeklyPctUsed: pct, weeklyModels: models });
const seg = (model, requests, meterSharePct) => ({ model, requests, meterSharePct });

// Test 1 — the week split. Within a week a model's cumulative count only rises,
// so a count going DOWN is the only exact reset signal. RED inputs named in
// the plan: a timestamp-gap splitter, a fixed threshold, or an absence-only
// splitter — each passes a simple monotonic series and fails this one.
test("splitWeeks: 1 — a falling request count splits the weeks", () => {
  const s = (reqs, at) => snap(at, [seg("m:cloud", reqs, 50)], 50);
  const weeks = splitWeeks([s(100, 1), s(250, 2), s(40, 3), s(90, 4)]);
  equal(weeks.length, 2, "RED: no split was made — the 250→40 fall is the only exact reset signal");
  deepEqual(weeks[0].map((x) => x.weeklyModels[0].requests), [100, 250], "the split lands BEFORE the 40");
  deepEqual(weeks[1].map((x) => x.weeklyModels[0].requests), [40, 90]);
});

// The second signal: a model present in one snapshot and absent from the next
// proves a reset as surely as a falling count — the page's model list is
// cumulative within a week, so disappearance is not an option mid-week.
test("splitWeeks: 1b — a model disappearing between snapshots splits too", () => {
  const a = snap(1, [seg("x:cloud", 100, 60), seg("y:cloud", 50, 40)], 50);
  const b = snap(2, [seg("x:cloud", 120, 100)], 20);                    // y vanished
  const c = snap(3, [seg("x:cloud", 130, 80), seg("y:cloud", 40, 20)], 25); // y back, lower
  const weeks = splitWeeks([a, b, c]);
  equal(weeks.length, 2, "RED: a count-only splitter never splits — x rises everywhere and y's fall has no before to compare against");
  deepEqual(weeks.map((w) => w.length), [1, 2]);
  equal(weeks[1].at(-1).weeklyModels.find((m) => m.model === "y:cloud").requests, 40);
});

// Test 2 — one reading per model per week, from that week's LAST snapshot.
// Within a week the snapshots are repeated views of one running total, so
// averaging them double-counts and weights by how often someone fetched.
test("costPerModel: 2 — one reading per week, from that week's LAST snapshot", () => {
  const rows = costPerModel([
    snap(1, [seg("m:cloud", 100, 10)], 50),
    snap(2, [seg("m:cloud", 200, 15)], 50),
    snap(3, [seg("m:cloud", 300, 25)], 50),
  ]);
  equal(rows.length, 1);
  equal(rows[0].ptsPerReq, (50 * 25) / 100 / 300, "RED: averaging the snapshots yields a different, wrong number");
  equal(rows[0].requests, 300);
  equal(rows[0].weeks, 1);
});

// Test 3 — the page's share has 0.1% resolution; a 0.0% share means "below
// resolution", NOT "free". Treating it as zero fabricates a free model and
// puts it top of any cost ranking — the most damaging wrong answer here.
test("costPerModel/multipliers: 3 — a 0.0% share is unknown, never zero", () => {
  const rows = multipliers(costPerModel([
    snap(1, [seg("cheap:cloud", 400, 90), seg("hidden:cloud", 150, 0)], 50),
  ]));
  const cheap = rows.find((r) => r.model === "cheap:cloud");
  const hidden = rows.find((r) => r.model === "hidden:cloud");
  ok(hidden, "the row is still listed — a silent drop reads as never-used");
  equal(hidden.ptsPerReq, null, "RED: a 0% share treated as measured fabricated a rate");
  equal(hidden.measuredRequests, 0);
  equal(hidden.mult, null, "RED: the unmeasured row got a multiplier (0x — free)");
  equal(cheap.mult, 1, "the one measured model is the floor");
});

// Test 4 — the thin-evidence gate reads measuredRequests, not requests: 190
// requests in a below-resolution week plus 30 measured must not clear the 200
// bar — and must not become the floor, or every other multiplier is wrong.
test("multipliers: 4 — unmeasured requests do not buy confidence", () => {
  const rows = multipliers(costPerModel([
    snap(1, [seg("sparse:cloud", 190, 0), seg("other:cloud", 900, 100)], 50),   // below resolution
    snap(2, [seg("sparse:cloud", 30, 6), seg("other:cloud", 400, 94)], 10),    // fresh week, both fall
  ]));
  const sparse = rows.find((r) => r.model === "sparse:cloud");
  const other = rows.find((r) => r.model === "other:cloud");
  equal(sparse.requests, 220);
  equal(sparse.measuredRequests, 30, "RED: gating on total requests clears the bar on 220");
  ok(sparse.measuredRequests < 200, "thin — 30 requests produced the rate, not 220");
  equal(sparse.weeks, 2);
  equal(sparse.measuredWeeks, 1, "the below-resolution week contributed requests, not a rate");
  // sparse's measured rate (0.02) is LOWER than other's weighted rate — a
  // wrong gate makes sparse the floor. Only reading measuredRequests keeps
  // other the floor. other's rate is request-weighted over its two weeks
  // (the requests cancel in the weighted mean, so it is points-per-week summed
  // over measured requests).
  equal(other.mult, 1, "RED: sparse's 190 unmeasured requests made it the floor");
  equal(sparse.mult, ((10 * 6) / 100 / 30) / (((50 * 100) / 100 + (10 * 94) / 100) / (900 + 400)));
});

// Guard — an empty eligible set has no floor. Math.min(...[]) is Infinity, and
// pts/Infinity fabricates a 0x cost for every measured model.
test("multipliers: nothing measured thick yet means every multiplier is null, not 0x", () => {
  const rows = multipliers(costPerModel([
    snap(1, [seg("m:cloud", 30, 50)], 50),
  ]));
  equal(rows[0].ptsPerReq, (50 * 50) / 100 / 30, "the rate exists — it is just thin");
  equal(rows[0].mult, null, "RED: an empty floor gave Infinity and a spurious 0x");
});

// Guard — an empty-meter week (weeklyPctUsed 0) yields ptsPerReq 0; that is not
// a free model, and 0/0 is not a multiplier.
test("multipliers: a zero ptsPerReq is not a free model", () => {
  const rows = multipliers(costPerModel([
    snap(1, [seg("m:cloud", 400, 100)], 0),
  ]));
  equal(rows[0].ptsPerReq, 0);
  equal(rows[0].mult, null, "RED: a 0 floor turned 0/0 into NaN or a spurious 0x that heads the sort");
});

// The reference skips zero-request segments outright (`if (!m.requests)
// continue`) — nothing was observed, so there is no row.
test("costPerModel: a zero-request segment yields no row", () => {
  const rows = multipliers(costPerModel([
    snap(1, [seg("ghost:cloud", 0, 10), seg("real:cloud", 400, 90)], 50),
  ]));
  ok(!rows.some((r) => r.model === "ghost:cloud"));
  equal(rows.find((r) => r.model === "real:cloud").mult, 1);
});

test("band: <2 → 1, 2..5 → 2, >5 → 3; unmeasured → null", () => {
  equal(band(1.9), 1);
  equal(band(2), 2);
  equal(band(4.9), 2);
  equal(band(5), 2);
  equal(band(5.1), 3);
  equal(band(null), null);
  equal(band("x"), null);
  equal(band(0.9, [1, 3]), 1);
  equal(band(1.5, [1, 3]), 2);
  equal(band(3, [1, 3]), 2);
  equal(band(3.5, [1, 3]), 3);
});

test("resolveBands: two positive finite numbers pass through; anything else falls back", () => {
  deepEqual(resolveBands([3, 6]), [3, 6]);
  deepEqual(resolveBands([0.5, 1.5]), [0.5, 1.5]);
  deepEqual(resolveBands(undefined), DEFAULT_COST_BANDS);
  deepEqual(resolveBands(null), DEFAULT_COST_BANDS);
  deepEqual(resolveBands([]), DEFAULT_COST_BANDS);
  deepEqual(resolveBands([2]), DEFAULT_COST_BANDS, "one edge is not a pair");
  deepEqual(resolveBands([2, 5, 9]), DEFAULT_COST_BANDS);
  deepEqual(resolveBands([5, 2]), [5, 2], "order is the caller's; a higher first edge is not auto-fixed");
  deepEqual(resolveBands(["2", 5]), DEFAULT_COST_BANDS, "a string edge invents nothing");
  deepEqual(resolveBands([0, 5]), DEFAULT_COST_BANDS, "0 is not a usable edge");
  deepEqual(resolveBands([-1, 5]), DEFAULT_COST_BANDS);
  deepEqual(resolveBands([2, Infinity]), DEFAULT_COST_BANDS);
  deepEqual(resolveBands([2, 5], [1, 3]), [2, 5], "the fallback is the caller's, over the default");
});

test("derivation is pure: inputs untouched, equal output on repeat", () => {
  const snaps = [
    snap(1, [seg("a:cloud", 190, 0), seg("b:cloud", 900, 100)], 50),
    snap(2, [seg("a:cloud", 30, 6), seg("b:cloud", 400, 94)], 10),
  ];
  const before = JSON.stringify(snaps);
  const first = multipliers(costPerModel(snaps));
  const second = multipliers(costPerModel(snaps));
  deepEqual(first, second);
  equal(JSON.stringify(snaps), before, "the input snapshots were mutated");
  // multipliers does not mutate its rows either — callers may reuse them
  const rows = costPerModel(snaps);
  const rowsBefore = JSON.stringify(rows);
  multipliers(rows);
  equal(JSON.stringify(rows), rowsBefore);
});