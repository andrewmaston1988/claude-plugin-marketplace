// Cost history — append-only JSONL at ~/.swarm/usage-history.jsonl, one line per
// live usage fetch that carried measurable weekly segments. `swarm cost` splits
// the lines into weeks and derives each model's per-request meter weight
// (multiplier against the cheapest measured model), so a seat's cost can be
// read beside `swarm perf`'s quality without ever collapsing the two into one
// number.
//
// Storage and derivation share this file: the thin I/O wrappers stay wrappers,
// the maths below them is pure over parsed snapshots.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";

export function usageHistoryPath(env = process.env) {
  return join(swarmHome(env), "usage-history.jsonl");
}

// One snapshot per line, one write per snapshot — the same line-atomic contract
// as model-scores.jsonl, so concurrent swarms cannot corrupt the history.
export function appendSnapshot(snapshot, path = usageHistoryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(snapshot) + "\n", "utf8");
}

export function readSnapshots(path) {
  if (!existsSync(path)) return [];
  const snaps = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      snaps.push(JSON.parse(line));
    } catch {
      // torn tail write from a concurrent append — skip, never abort a query
    }
  }
  return snaps;
}

// ---- derivation ──────────────────────────────────────────────────────────────
// Ported field-for-field from the operator-side cost-table arithmetic: any
// disagreement between the two on the same history is a port defect, not a
// rounding difference. Pure maths — everything below takes parsed snapshots,
// nothing reads the filesystem.

export const THIN_REQUESTS = 200;
export const DEFAULT_COST_BANDS = [2, 5];

// Split snapshots into weeks. Within a week a model's cumulative `requests`
// only ever RISES, so a count falling between two consecutive snapshots proves
// a reset happened between them — exact, no threshold, unlike watching
// weeklyPctUsed fall (an arbitrary margin that misses a boundary whenever the
// new week climbs past the old one's last reading). A model present in one
// snapshot and absent from the next proves a reset as surely: the page's model
// list is cumulative within a week, so disappearance is not an option mid-week.
export function splitWeeks(snaps) {
  if (!snaps.length) return [];
  const reqsOf = (s) => new Map((s.weeklyModels || []).map((m) => [m.model, m.requests]));
  const weeks = [];
  let cur = [snaps[0]];
  for (let i = 1; i < snaps.length; i++) {
    const before = reqsOf(snaps[i - 1]);
    const after = reqsOf(snaps[i]);
    let reset = false;
    for (const [model, n] of after) {
      if (before.has(model) && n < before.get(model)) { reset = true; break; }
    }
    if (!reset) {
      for (const model of before.keys()) {
        if (!after.has(model)) { reset = true; break; }
      }
    }
    if (reset) {
      weeks.push(cur);
      cur = [];
    }
    cur.push(snaps[i]);
  }
  weeks.push(cur);
  return weeks;
}

// One reading per model per week, from that week's LAST snapshot — within a
// week the snapshots are repeated views of one running total, so a flat mean
// double-counts and weights the result by how often someone happened to
// fetch. `weeklyPctUsed x share` is the absolute figure; weeklyPctUsed cancels
// in any ratio between two models. A 0.0% share is "below the page's 0.1%
// resolution", not "free" — the row is still listed (a silent drop reads as
// never-used) but its cost stays unmeasured.
export function costPerModel(snaps) {
  const readings = new Map();
  for (const wk of splitWeeks(snaps)) {
    const last = wk[wk.length - 1];
    const pct = last.weeklyPctUsed ?? 0;
    for (const m of last.weeklyModels || []) {
      if (!m.requests) continue;
      const measured = m.meterSharePct > 0;
      const ptsPerReq = measured ? (pct * m.meterSharePct) / 100 / m.requests : null;
      if (!readings.has(m.model)) readings.set(m.model, []);
      readings.get(m.model).push({ requests: m.requests, ptsPerReq });
    }
  }
  const rows = [];
  for (const [model, rs] of readings) {
    const reqs = rs.reduce((a, r) => a + r.requests, 0);
    // Weight over the weeks that produced a figure: a week below the page's
    // resolution contributes its requests to the total but cannot contribute
    // a rate — unknown, not zero.
    const seen = rs.filter((r) => r.ptsPerReq != null);
    const seenReqs = seen.reduce((a, r) => a + r.requests, 0);
    rows.push({
      model,
      ptsPerReq: seenReqs ? seen.reduce((a, r) => a + r.ptsPerReq * r.requests, 0) / seenReqs : null,
      requests: reqs,
      // The requests that actually PRODUCED the rate. The confidence gate reads
      // this one — an unmeasurable week must not buy a model the credibility
      // of volume it never contributed.
      measuredRequests: seenReqs,
      weeks: rs.length,
      measuredWeeks: seen.length,
    });
  }
  return rows;
}

// Multipliers relative to the cheapest model with >= THIN_REQUESTS measured
// requests. The floor must be a MEASURED model. An empty eligible set (nothing
// measured thick yet) has no floor: Math.min over nothing is Infinity, and
// pts/Infinity would fabricate a 0x cost for every measured model. Likewise a
// zero ptsPerReq (an empty meter) is not a free model.
export function multipliers(rows) {
  const eligible = rows.filter((r) => r.measuredRequests >= THIN_REQUESTS && r.ptsPerReq != null && r.ptsPerReq > 0);
  const floor = eligible.length ? Math.min(...eligible.map((r) => r.ptsPerReq)) : null;
  const out = rows.map((r) => ({
    ...r,
    mult: floor != null && r.ptsPerReq != null && r.ptsPerReq > 0 ? r.ptsPerReq / floor : null,
  }));
  // Unmeasured rows sort last; they are listed to be seen, not ranked.
  out.sort((a, b) => (b.mult ?? -1) - (a.mult ?? -1));
  return out;
}

// Cost band for surfacing: 1 cheap, 2 mid, 3 expensive. Unmeasured is null.
export function band(mult, bands = DEFAULT_COST_BANDS) {
  if (mult == null || !Number.isFinite(mult)) return null;
  if (mult < bands[0]) return 1;
  if (mult <= bands[1]) return 2;
  return 3;
}

// The band boundaries are arbitrary numbers, so they are config
// (`provider.cloud.ollama.costBands`), not constants. Anything malformed falls
// back to the default rather than inventing an edge out of a string.
export function resolveBands(value, fallback = DEFAULT_COST_BANDS) {
  return Array.isArray(value) && value.length === 2
    && value.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    ? [...value]
    : fallback;
}