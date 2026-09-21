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
  resolveBands, normalizeCostObservation, codexUnpricedObservation, relativeCostRows, DEFAULT_COST_BANDS,
  ollamaCloudCostRows, costRowsFor, costSections, costUnitLabel, rateCardRows, COST_PROVIDERS, RATE_CARDS,
  CODEX_RATE_CARD, CLAUDE_RATE_CARD,
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

test("incompatible provider cost units never share a multiplier floor", () => {
  const rows = multipliers([
    { provider: "ollama", model: "same-model", unit: "meter-points", classification: "unpriced", ptsPerReq: 2, measuredRequests: 400, requests: 400, weeks: 1, measuredWeeks: 1 },
    { provider: "codex", model: "same-model", unit: "usd", classification: "api-equivalent estimate", ptsPerReq: 0.01, measuredRequests: 400, requests: 400, weeks: 1, measuredWeeks: 1 },
  ]);
  equal(rows.find((row) => row.provider === "ollama").mult, 1);
  equal(rows.find((row) => row.provider === "codex").mult, null, "USD/API estimates are not Ollama meter weights");
});

test("cost observations carry canonical provenance and Codex billing stays explicitly unpriced", () => {
  deepEqual(normalizeCostObservation({
    provider: "codex", model: "same-model", unit: "usd", source: "pricing-table",
    classification: "api-equivalent estimate", asOf: "2026-09-19",
  }), {
    provider: "codex", model: "same-model", unit: "usd", source: "pricing-table",
    classification: "api-equivalent estimate", asOf: "2026-09-19T00:00:00.000Z",
  });
  deepEqual(codexUnpricedObservation("same-model", { asOf: "2026-09-19" }), {
    provider: "codex", model: "same-model", unit: "usd", source: "codex-app-server",
    classification: "unpriced", asOf: "2026-09-19T00:00:00.000Z",
  });
});

test("provider-local rate-card weights use an explicit Codex base model", () => {
  const rows = relativeCostRows([
    { provider: "codex", model: "gpt-5.6-sol", unit: "codex-plan-relative", source: "codex-rate-card", classification: "unpriced", value: 12 },
    { provider: "codex", model: "gpt-5.6-luna", unit: "codex-plan-relative", source: "codex-rate-card", classification: "unpriced", value: 3 },
    { provider: "ollama", model: "same-id", unit: "meter-points", source: "ollama-settings", classification: "unpriced", value: 99 },
  ], { baseModels: { codex: "gpt-5.6-luna" } });
  equal(rows.find((row) => row.model === "gpt-5.6-luna").mult, 1);
  equal(rows.find((row) => row.model === "gpt-5.6-sol").mult, 4);
  equal(rows.find((row) => row.model === "gpt-5.6-sol").baseModel, "gpt-5.6-luna");
  equal(rows.find((row) => row.provider === "ollama").mult, null, "a Codex base never prices another provider");
});

// ── provider-local rate cards ─────────────────────────────────────────────────
// Three lists, one per provider, each ranked cheapest→dearest within its own
// accounting unit. Never one merged list: a measured Ollama meter point and a
// published Codex price do not share an axis, and a shared floor would rank one
// against the other silently and permanently.

// A history whose model name collides with a Codex id, and which prices that
// name at 9x its own floor. Any leak of the meter into the Codex list hands the
// Codex row a real, wrong number rather than a null.
const collidingSnaps = () => [
  snap(1, [seg("gpt-5.6-luna:cloud", 100, 50), seg("cheap:cloud", 900, 50)], 50),
];

// The plan's named RED anchor. Nothing guarded this before: the Ollama
// derivation and the provider tables had no seam between them.
test("costRowsFor: an Ollama meter multiplier never attaches to a Codex model", () => {
  const snaps = collidingSnaps();
  const leaked = ollamaCloudCostRows(snaps).find((r) => r.model.startsWith("gpt-5.6-luna"));
  ok(leaked, "the fixture must actually price the colliding name, or this test proves nothing");
  ok(leaked.mult !== 1, `the meter's own weight for the colliding name is ${leaked.mult} — the fixture must make it differ from the table's 1x`);

  const rows = costRowsFor("codex", { models: ["gpt-5.6-luna"], snaps });
  const luna = rows.find((r) => r.model === "gpt-5.6-luna");
  ok(luna, "the Codex base is missing from its own list");
  equal(luna.mult, 1, "RED: the Ollama meter's weight leaked onto a Codex model");
  equal(luna.baseModel, "gpt-5.6-luna");
  equal(luna.costDomain, `codex:${CODEX_RATE_CARD.unit}`, "a Codex row lives in the Codex cost domain");
  ok(rows.every((r) => r.unit !== "meter-points"), "RED: a meter unit reached the Codex list");
  ok(rows.every((r) => r.source !== "ollama-settings"), "RED: an Ollama source reached the Codex list");
  ok(rows.every((r) => r.provider === "codex"), "RED: another provider's row landed in the Codex list");
});

// The absolute form of the same invariant: the history cannot reach the table's
// list at all — not through a request count, not through a quota percentage.
// `swarm-provider-economics:63` forbids deriving USD from quota outright.
test("costRowsFor: a Codex weight is never derived from the usage history or a quota percentage", () => {
  const quiet = [snap(1, [seg("m:cloud", 400, 100)], 10)];
  const busy = [snap(1, [seg("m:cloud", 400, 100)], 90)];
  const asked = { models: ["gpt-5.6-luna", "gpt-5.6-sol"] };
  deepEqual(costRowsFor("codex", { ...asked, snaps: busy }), costRowsFor("codex", { ...asked, snaps: quiet }),
    "RED: the table's weights moved with the banked quota history");
  deepEqual(costRowsFor("codex", { ...asked, snaps: busy }), costRowsFor("codex", asked),
    "RED: the Codex list read the history it must never read");
  deepEqual(costRowsFor("claude", { ...asked, snaps: busy }), costRowsFor("claude", asked));
});

test("costRowsFor: each provider's list is normalised to its own named base", () => {
  equal(CODEX_RATE_CARD.baseModel, "gpt-5.6-luna");
  equal(CLAUDE_RATE_CARD.baseModel, "claude-sonnet-5");
  const codex = costRowsFor("codex", { models: ["gpt-5.6-luna", "gpt-5.6-sol"] });
  equal(codex.find((r) => r.model === "gpt-5.6-luna").mult, 1, "RED: the Codex base is not exactly 1x");
  const claude = costRowsFor("claude", { models: ["claude-sonnet-5", "claude-opus-5"] });
  equal(claude.find((r) => r.model === "claude-sonnet-5").mult, 1, "RED: the Claude base is not exactly 1x");
  ok(codex.every((r) => r.costDomain.startsWith("codex:")), "a Codex list carries only Codex domains");
  ok(claude.every((r) => r.costDomain.startsWith("claude:")), "a Claude list carries only Claude domains");
  ok(!codex.some((r) => r.model === "claude-sonnet-5"), "a Codex list never carries a Claude model");
});

// Cheapest→dearest is tested on a synthetic card so the ordering logic is pinned
// independently of whatever the shipped tables happen to contain. A named base
// of 2 with a cheaper entry of 1 is the whole point: the unit is the model the
// table names, never the cheapest row it happens to contain.
test("rateCardRows: ranks cheapest first within one provider, unmeasured last, base named not derived", () => {
  const card = { provider: "codex", baseModel: "b", unit: "u", source: "s", asOf: "2026-09-21",
    prices: { b: { input: 2, output: 10 }, dear: { input: 8, output: 40 }, cheap: { input: 1, output: 5 } } };
  const rows = rateCardRows(card, ["unknown"]);
  deepEqual(rows.map((r) => r.model), ["cheap", "b", "dear", "unknown"], "RED: cheapest first, unmeasured last");
  equal(rows[0].mult, 0.5);
  equal(rows.find((r) => r.model === "b").mult, 1, "RED: the floor was derived from the cheapest row, not the named base");
  equal(rows.find((r) => r.model === "dear").mult, 4);
  equal(rows.find((r) => r.model === "unknown").mult, null);
});

// A model absent from its table is a ROW, not a blank. The Claude section of
// the dashboard was empty for exactly this reason and read as broken.
test("costRowsFor: a model absent from its table is an unpriced row, never a blank", () => {
  // Rosalind is in the rate card's *Chat* table and absent from the Work/Codex
  // one this card is read from, so it is genuinely unpriced for a Codex seat.
  const rows = costRowsFor("codex", { models: ["gpt-rosalind-research"] });
  const absent = rows.find((r) => r.model === "gpt-rosalind-research");
  ok(absent, "RED: the model was dropped from the list — a blank panel reads as broken");
  equal(absent.mult, null, "RED: a weight was invented for a model with no published price");
  equal(absent.classification, "unpriced");
  equal(absent.provider, "codex");
  ok(costRowsFor("codex").some((r) => r.model === CODEX_RATE_CARD.baseModel), "the table's own models are always listed");
  ok(costRowsFor("claude", { models: ["claude-opus-5"] }).some((r) => r.model === "claude-opus-5"));
});

// A card stores the PUBLISHED COLUMNS, not a collapsed ratio. Collapsing assumes
// a fixed output/input relationship, which Codex does not have — astra and sol
// are 5x output/input, terra, luna and 5.5 are 6x — so a single stored number
// silently goes wrong the moment one column moves on its own.
test("rate cards: each price is the published columns, so a column change updates the card", () => {
  // openai.com help centre, ChatGPT Rate Card (Enterprise token-based pricing),
  // "ChatGPT Work and Codex models" — the table that governs Codex CLI usage.
  deepEqual(CODEX_RATE_CARD.prices["gpt-6-astra"], { input: 10, cachedInput: 1, output: 50 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-sol"], { input: 4, cachedInput: 0.4, output: 20 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-terra"], { input: 2, cachedInput: 0.2, output: 12 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.6-luna"], { input: 0.2, cachedInput: 0.02, output: 1.2 });
  deepEqual(CODEX_RATE_CARD.prices["gpt-5.5"], { input: 5, cachedInput: 0.5, output: 30 });

  // Anthropic's table publishes no cache-read rate except Fable's, so the field
  // is absent rather than guessed on every other row.
  deepEqual(CLAUDE_RATE_CARD.prices["claude-haiku-4-5-20251001"], { input: 1, output: 5 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-sonnet-5"], { input: 2, output: 10 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-opus-5"], { input: 5, output: 25 });
  deepEqual(CLAUDE_RATE_CARD.prices["claude-fable-5-1"], { input: 10, cachedInput: 0.25, output: 50 });
});

// The basis is the INPUT column. Swarm leaves are input- and cache-read
// dominated (a measured implementation leaf: 2.12M in, 12.8k out), and for
// every Codex model cached input is exactly 0.1x input, so the cached column
// yields the identical ratio. The output column does NOT: an output-basis card
// puts astra at 41.67x and sol at 16.67x, which is what the two values below pin.
test("costRowsFor: a rate-card multiplier is the input column over the card's named base", () => {
  const rows = costRowsFor("codex");
  const mult = (id) => rows.find((r) => r.model === id)?.mult;
  equal(mult("gpt-5.6-luna"), 1, "RED: the base must be exactly 1x");
  equal(mult("gpt-5.6-terra"), 10, "RED: terra is $2.00 input against luna's $0.20");
  equal(mult("gpt-5.6-sol"), 20, "RED: sol is $4.00 input against luna's $0.20 — 16.67x means an output basis");
  equal(mult("gpt-5.5"), 25, "RED: 5.5 is $5.00 input against luna's $0.20");
  equal(mult("gpt-6-astra"), 50, "RED: astra is $10.00 input against luna's $0.20 — 41.67x means an output basis");
});

test("CLAUDE_RATE_CARD: the published ratios, keyed on the ids swarm dispatches", () => {
  const rows = costRowsFor("claude");
  const mult = (id) => rows.find((r) => r.model === id)?.mult;
  equal(mult("claude-haiku-4-5-20251001"), 0.5, "RED: haiku is $1 input against sonnet's $2");
  equal(mult("claude-sonnet-5"), 1, "RED: the base must be exactly 1x");
  equal(mult("claude-opus-5"), 2.5, "RED: opus is $5 input against sonnet's $2");
  equal(mult("claude-fable-5-1"), 5, "RED: fable is $10 input against sonnet's $2");
  // A Claude family shares its tier's published price (operator, 2026-09-21:
  // "claude doesn't vary prices for a model family as far as I know"), so a
  // family member carries its tier's figures rather than a number of its own.
  // This row is what caught sonnet-4-6 shipping at an invented 1.5x.
  equal(mult("claude-sonnet-4-6"), 1, "RED: sonnet-4-6 is the sonnet tier's $2 input, not a value of its own");
  equal(mult("claude-opus-4-8"), 2.5, "RED: opus-4-8 is the opus tier's $5 input, not a value of its own");
  // The catalog's haiku id carries a date suffix the rate doc's does not. Keying
  // on the doc's bare id renders the model swarm actually seats as `unpriced`.
  ok(!Object.keys(CLAUDE_RATE_CARD.prices).includes("claude-haiku-4-5"),
    "RED: the card is keyed on the doc's bare haiku id, not the one swarm dispatches");
});

// A price READ off the table and a price taken from the family tier are not the
// same evidence, and the row has to say which — an inference that renders
// identically to a reading is how a made-up 1.5x for sonnet-4-6 shipped in #307.
test("rate cards: a family-tier price is marked as one, a directly published price is not", () => {
  equal(CLAUDE_RATE_CARD.prices["claude-sonnet-4-6"].via, "claude-sonnet-5",
    "RED: sonnet-4-6 is priced from the sonnet tier and must name where the figure came from");
  equal(CLAUDE_RATE_CARD.prices["claude-opus-4-8"].via, "claude-opus-5",
    "RED: opus-4-8 is priced from the opus tier and must name where the figure came from");
  equal(CLAUDE_RATE_CARD.prices["claude-sonnet-5"].via, undefined,
    "RED: a directly published price must not claim a family tier");
  equal(CODEX_RATE_CARD.prices["gpt-5.6-sol"].via, undefined,
    "RED: every Codex figure is read off its table, so none is a family tier");

  const rows = costRowsFor("claude");
  const row = (id) => rows.find((r) => r.model === id);
  equal(row("claude-sonnet-4-6").pricedVia, "claude-sonnet-5", "RED: the marker never reached the row");
  equal(row("claude-sonnet-5").pricedVia, undefined, "RED: a published row was marked as inferred");
  // The inference must not change the number, only its provenance.
  equal(row("claude-sonnet-4-6").mult, row("claude-sonnet-5").mult);
});

// The pinned key sets ARE the sourcing record: adding a row without reading it
// off a published table fails here, which is the only thing standing between a
// guessed price and a permanent mis-rank.
test("rate cards: no price is invented — every key traces to a published table", () => {
  deepEqual(Object.keys(CODEX_RATE_CARD.prices).sort(), [
    "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra",
  ], "RED: a Codex price was added or removed without updating the published set");
  deepEqual(Object.keys(CLAUDE_RATE_CARD.prices).sort(), [
    "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-opus-4-8",
    "claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5",
  ], "RED: a Claude price was added or removed without updating the published set");
  // A model in neither table is a row that says so, never a blank and never a guess.
  const rosalind = costRowsFor("codex", { models: ["gpt-rosalind-research"] })
    .find((r) => r.model === "gpt-rosalind-research");
  equal(rosalind.mult, null, "a model absent from the table must carry no weight");
});

test("rate cards: a published-price weight is an api-equivalent estimate, never a bill", () => {
  const base = costRowsFor("codex", { models: ["gpt-5.6-luna"] }).find((r) => r.model === "gpt-5.6-luna");
  equal(base.classification, "api-equivalent estimate",
    "RED: a subscription-derived figure was labelled as money actually spent");
  ok(costRowsFor("claude", { models: ["claude-sonnet-5", "claude-opus-5"] }).every((r) => r.classification !== "billed"));
});

test("costUnitLabel: each list is labelled in its own unit, naming its own base", () => {
  match(costUnitLabel("ollama"), /meter points/);
  ok(costUnitLabel("codex").includes(CODEX_RATE_CARD.baseModel), "the Codex label must name what it is relative to");
  ok(costUnitLabel("claude").includes(CLAUDE_RATE_CARD.baseModel));
  ok(costUnitLabel("codex") !== costUnitLabel("claude"), "two bases are two units, not one label");
});

test("COST_PROVIDERS: one entry per provider with a cost source, Ollama's meter first", () => {
  deepEqual(COST_PROVIDERS, ["ollama", "codex", "claude"]);
});

test("costSections: one section per provider, never a merged list", () => {
  const sections = costSections({ snaps: collidingSnaps(), models: { codex: ["gpt-5.6-sol"] } });
  deepEqual(sections.map((s) => s.provider), ["ollama", "codex", "claude"], "a provider with no source still gets a section");
  ok(sections.every((s) => s.rows.every((r) => (r.provider || "ollama") === s.provider)),
    "RED: one provider's rows landed in another's section");
  ok(sections.every((s) => typeof s.unit === "string" && s.unit.length), "every section states its own unit");
  const ollama = sections.find((s) => s.provider === "ollama");
  deepEqual(ollama.rows.map((r) => r.model), ollamaCloudCostRows(collidingSnaps()).map((r) => r.model),
    "the Ollama section is still the meter's own rows");
  // A section per provider is not a ranking across providers: no row is ever
  // re-weighted against another section's base.
  ok(sections.every((s) => s.rows.every((r) => !r.baseModel || s.provider !== "ollama")),
    "a rate-card base priced an Ollama meter row");
});

test("costSections: a past-dated rate card announces its stale published prices", () => {
  const provider = "test-stale-rate-card";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2020-02-01", prices: { base: { input: 1, output: 1 } },
  };
  try {
    const section = costSections({ providers: [provider] })[0];
    ok(section.banner.length > 0, "RED: a past-dated rate card must announce itself");
    match(section.banner.join("\n"), /Stale Rate Card/);
    match(section.banner.join("\n"), new RegExp(provider));
    match(section.banner.join("\n"), /2020-01-01T00:00:00\.000Z/);
    equal(section.banner[1], "    Refresh: re-read the published rate card");
  } finally {
    delete RATE_CARDS[provider];
  }
});

test("costSections: a fresh rate card stays silent", () => {
  const provider = "test-fresh-rate-card";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2099-01-01", prices: { base: { input: 1, output: 1 } },
  };
  try {
    const section = costSections({ providers: [provider] })[0];
    deepEqual(section.banner, [], "RED: a fresh rate card must not print a stale-data banner");
  } finally {
    delete RATE_CARDS[provider];
  }
});

test("costSections: a stale rate-card row keeps its published value", () => {
  const provider = "test-stale-value";
  RATE_CARDS[provider] = {
    provider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2020-02-01", prices: { base: { input: 7, output: 1 } },
  };
  try {
    const row = costSections({ providers: [provider] })[0].rows.find((candidate) => candidate.model === "base");
    equal(row.value, 7, "RED: a stale rate card must retain its published price");
  } finally {
    delete RATE_CARDS[provider];
  }
});

test("costSections: a default shelf life does not override an explicit expiry", () => {
  const explicitProvider = "test-explicit-expiry";
  const defaultProvider = "test-default-expiry";
  RATE_CARDS[explicitProvider] = {
    provider: explicitProvider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", staleAfter: "2099-01-01", prices: { base: { input: 1, output: 1 } },
  };
  RATE_CARDS[defaultProvider] = {
    provider: defaultProvider, baseModel: "base", unit: "published-price-relative", source: "test-rate-card",
    asOf: "2020-01-01", prices: { base: { input: 1, output: 1 } },
  };
  try {
    const [explicit, defaulted] = costSections({ providers: [explicitProvider, defaultProvider] });
    deepEqual(explicit.banner, [], "RED: an explicit staleAfter must win over the default shelf life");
    ok(defaulted.banner.length > 0, "RED: a card with no expiry must use the default shelf life");
  } finally {
    delete RATE_CARDS[explicitProvider];
    delete RATE_CARDS[defaultProvider];
  }
});

test("rate cards: shipped staleAfter dates are still in the future", () => {
  for (const card of [CODEX_RATE_CARD, CLAUDE_RATE_CARD]) {
    ok(card.staleAfter, `RED: ${card.provider} must state when its rate card goes stale`);
    ok(Date.parse(`${card.staleAfter}T23:59:59.999Z`) > Date.now(),
      `RED: ${card.provider}'s rate card is past ${card.staleAfter}; re-read the published price table`);
  }
});
