// Predictive run estimates: worst-case leaf counts × historical per-model
// medians from past runs' summary.json files. Consent infrastructure — the
// estimate sits on the approval surface (validate + run start), projects once
// mid-run, and is compared against actuals at close. Never a guess: models
// with no history are named as uncounted, a fully cold corpus yields null.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenTotal } from "./stream.mjs";
import { formatTokens } from "./results.mjs";
import { inferStoredIdentity } from "./results.mjs";
import { modelKey } from "./contracts.mjs";
import { isAgentless } from "./manifest.mjs";

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const push = (map, key, v) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(v);
};

// New corpus entries use the canonical provider/model key. The compatibility
// lookup lets old callers continue asking for `.get("sonnet")` when exactly
// one qualified history exists, without storing a second copy that could
// collide with a newly discovered provider.
class ProviderModelMap extends Map {
  get(key) {
    const direct = super.get(key);
    if (direct !== undefined || super.has(key)) return direct;
    if (typeof key !== "string") return undefined;
    const matches = [...super.entries()].filter(([candidate]) => {
      try { return Array.isArray(JSON.parse(candidate)) && JSON.parse(candidate)[1] === key; } catch { return false; }
    });
    return matches.length === 1 ? matches[0][1] : undefined;
  }

  has(key) {
    if (super.has(key)) return true;
    return this.get(key) !== undefined;
  }
}

function identityOf(record) {
  const model = typeof record?.model === "string" ? record.model.trim() : record?.model;
  const explicit = typeof record?.provider === "string" && record.provider.trim();
  const inferred = explicit ? {} : inferStoredIdentity(model);
  return {
    provider: (explicit ? record.provider.trim() : inferred.provider) || null,
    model,
    explicit: Boolean(explicit),
  };
}

function keyOf(identity) {
  return identity.provider ? modelKey(identity.provider, identity.model) : JSON.stringify([null, identity.model]);
}

function shownIdentity(identity) {
  return identity.explicit && identity.provider ? `${identity.provider}/${identity.model}` : identity.model;
}

// Walk runsRoot/<encoded-repo-toplevel>/<run>/summary.json (two fixed levels, cross-
// project — per-model cost is a property of the model, not the repo). Rows
// need state ok + a real model + tokens; pre-D1 summaries lack `model` and
// simply don't contribute. Every read is best-effort.
export function loadCorpus(runsRoot) {
  const tokens = new ProviderModelMap();
  const costUsd = new ProviderModelMap();
  let l1 = [];
  try { l1 = readdirSync(runsRoot); } catch { return { tokens, costUsd }; }
  for (const a of l1) {
    let l2 = [];
    try { l2 = readdirSync(join(runsRoot, a)); } catch { continue; }
    for (const b of l2) {
      let summary;
      try { summary = JSON.parse(readFileSync(join(runsRoot, a, b, "summary.json"), "utf8")); } catch { continue; }
      for (const row of summary?.tasks || []) {
        if (row?.state !== "ok" || typeof row.model !== "string" || isAgentless(row) || !row.tokens) continue;
        const identity = identityOf(row);
        push(tokens, keyOf(identity), tokenTotal(row.tokens));
        // costUsd is real only for Anthropic-billed leaves. On a :cloud row the CLI
        // applies its own price table to token counts, but the provider bills on
        // subscription/GPU cycles with no token->$ mapping — that dollar figure is
        // fiction, and feeding it to the estimator would fabricate the cost the
        // operator consents against. Tokens (above) are real for every model.
        const billed = row.costClassification === "billed" || row.costObservation?.classification === "billed";
        if (Number.isFinite(row.costUsd) && ((identity.provider === "claude" && !row.provider) || billed)) {
          push(costUsd, keyOf(identity), row.costUsd);
        }
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
    if (isAgentless(t)) continue;
    const mult = t.forEach ? t.forEach.maxItems : 1;
    if (t.childPlan) {
      for (const c of t.childPlan.tasks) {
        if (isAgentless(c)) continue;
        add(c.model, mult * (c.forEach ? c.forEach.maxItems : 1));
      }
      continue;
    }
    add(t.model, mult);
  }
  if (digest?.model) add(digest.model, 1);
  return counts;
}

// integrate.from naming a forEach parent is a variable-width join: the cap on
// what it can fold in is the parent's own maxItems. Named separately from
// leafCounts because integrate is agentless (no model, no token cost) — this
// is a branch-count warning for the validate preview, not a spend estimate.
export function integrateCaps(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const lines = [];
  for (const t of tasks) {
    if (!t.integrate) continue;
    for (const srcId of t.integrate.from) {
      const src = byId.get(srcId);
      if (src?.forEach) lines.push(`${t.id} ≤ ${src.forEach.maxItems} branches (${srcId} forEach)`);
    }
  }
  return lines;
}

// -> null when no counted model has history, else { tokens, usd?, counted, unknown }.
// usd appears only with full coverage: no unknown models, cost samples for
// every counted one — synthetic dollars for subscription corpora are noise.
export function estimateRun(tasks, digest, corpus) {
  const counted = [];
  const unknown = [];
  const counts = new Map();
  const add = (task, leaves) => {
    if (isAgentless(task)) return;
    const identity = identityOf(task);
    const key = keyOf(identity);
    const current = counts.get(key);
    if (current) current.leaves += leaves;
    else counts.set(key, { ...identity, leaves });
  };
  for (const t of tasks) {
    if (isAgentless(t)) continue;
    const mult = t.forEach ? t.forEach.maxItems : 1;
    if (t.childPlan) {
      for (const c of t.childPlan.tasks) add(c, mult * (c.forEach ? c.forEach.maxItems : 1));
    } else add(t, mult);
  }
  if (digest?.model) add(digest, 1);

  const lookup = (map, identity) => {
    const qualified = map?.get(keyOf(identity));
    if (qualified !== undefined) return qualified;
    // A model-only corpus supplied by an old caller is safe only for a
    // model-only task. Explicit provider identity must never fall through and
    // borrow another provider's samples.
    return identity.explicit ? undefined : map?.get(identity.model);
  };
  for (const identity of counts.values()) {
    const samples = lookup(corpus.tokens, identity);
    const output = identity.explicit && identity.provider ? { provider: identity.provider, model: identity.model } : { model: identity.model };
    if (samples?.length) counted.push({ ...output, leaves: identity.leaves, perLeaf: median(samples) });
    else unknown.push({ ...output, leaves: identity.leaves });
  }
  if (!counted.length) return null;
  const est = {
    tokens: counted.reduce((n, c) => n + c.leaves * c.perLeaf, 0),
    counted,
    unknown,
  };
  if (!unknown.length && counted.every((c) => lookup(corpus.costUsd, identityOf(c))?.length)) {
    est.usd = counted.reduce((n, c) => n + c.leaves * median(lookup(corpus.costUsd, identityOf(c))), 0);
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
    line += ` (no history for: ${est.unknown.map((u) => u.provider ? `${u.provider}/${u.model}` : u.model).join(", ")} — ${leaves} leaves uncounted)`;
  }
  return line;
}
