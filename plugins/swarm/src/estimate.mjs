// Predictive run estimates: worst-case leaf counts × historical per-model
// medians from past runs' summary.json files. Consent infrastructure — the
// estimate sits on the approval surface (validate + run start), projects once
// mid-run, and is compared against actuals at close. Never a guess: models
// with no history are named as uncounted, a fully cold corpus yields null.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenTotal } from "./stream.mjs";
import { formatTokens } from "./results.mjs";

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const push = (map, key, v) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(v);
};

// Walk runsRoot/<encoded-cwd>/<run>/summary.json (two fixed levels, cross-
// project — per-model cost is a property of the model, not the repo). Rows
// need state ok + a real model + tokens; pre-D1 summaries lack `model` and
// simply don't contribute. Every read is best-effort.
export function loadCorpus(runsRoot) {
  const tokens = new Map();
  const costUsd = new Map();
  let l1 = [];
  try { l1 = readdirSync(runsRoot); } catch { return { tokens, costUsd }; }
  for (const a of l1) {
    let l2 = [];
    try { l2 = readdirSync(join(runsRoot, a)); } catch { continue; }
    for (const b of l2) {
      let summary;
      try { summary = JSON.parse(readFileSync(join(runsRoot, a, b, "summary.json"), "utf8")); } catch { continue; }
      for (const row of summary?.tasks || []) {
        if (row?.state !== "ok" || typeof row.model !== "string" || row.model === "compute" || !row.tokens) continue;
        push(tokens, row.model, tokenTotal(row.tokens));
        if (Number.isFinite(row.costUsd)) push(costUsd, row.model, row.costUsd);
      }
    }
  }
  return { tokens, costUsd };
}

// Worst-case leaf counts per model: forEach counts maxItems (the cap IS the
// approval), compute counts zero, the digest is one more leaf of its model.
// A manifest node contributes its child's leaves (× maxItems under forEach) —
// the approval invariant survives composition. Exported: the validate preview
// counts from the same table the estimate does.
export function leafCounts(tasks, digest) {
  const counts = new Map();
  const add = (model, n) => counts.set(model, (counts.get(model) || 0) + n);
  for (const t of tasks) {
    if (t.compute !== undefined || t.model === "compute") continue;
    const mult = t.forEach ? t.forEach.maxItems : 1;
    if (t.childPlan) {
      for (const c of t.childPlan.tasks) {
        if (c.compute !== undefined || c.model === "compute") continue;
        add(c.model, mult * (c.forEach ? c.forEach.maxItems : 1));
      }
      continue;
    }
    add(t.model, mult);
  }
  if (digest?.model) add(digest.model, 1);
  return counts;
}

// -> null when no counted model has history, else { tokens, usd?, counted, unknown }.
// usd appears only with full coverage: no unknown models, cost samples for
// every counted one — synthetic dollars for subscription corpora are noise.
export function estimateRun(tasks, digest, corpus) {
  const counted = [];
  const unknown = [];
  for (const [model, leaves] of leafCounts(tasks, digest)) {
    const samples = corpus.tokens.get(model);
    if (samples?.length) counted.push({ model, leaves, perLeaf: median(samples) });
    else unknown.push({ model, leaves });
  }
  if (!counted.length) return null;
  const est = {
    tokens: counted.reduce((n, c) => n + c.leaves * c.perLeaf, 0),
    counted,
    unknown,
  };
  if (!unknown.length && counted.every((c) => corpus.costUsd.get(c.model)?.length)) {
    est.usd = counted.reduce((n, c) => n + c.leaves * median(corpus.costUsd.get(c.model)), 0);
  }
  return est;
}

// Linear projection over completed leaves; unit-agnostic (tokens or dollars).
// Null under 2 completed — one leaf is not a trend.
export function projectRun({ spent, completed, remaining }) {
  if (completed < 2) return null;
  return spent + (spent / completed) * remaining;
}

export function formatEstimate(est) {
  if (!est) return "estimate: none (no run history yet)";
  let line = `estimated ~${formatTokens(est.tokens)} tokens`;
  if (est.usd != null) line += ` · ~$${est.usd.toFixed(2)}`;
  if (est.unknown.length) {
    const leaves = est.unknown.reduce((n, u) => n + u.leaves, 0);
    line += ` (no history for: ${est.unknown.map((u) => u.model).join(", ")} — ${leaves} leaves uncounted)`;
  }
  return line;
}
