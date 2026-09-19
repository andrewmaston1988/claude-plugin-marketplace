// Model capability scores — append-only JSONL at ~/.swarm/model-scores.jsonl.
//
// One row per graded leaf. Line-atomic appends, so concurrent swarms cannot
// corrupt the store and no run dirties the repo. The aggregator is pure — it
// takes rows, not a path — so it tests without fixtures.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";
import { UNIVERSAL, ASPECTS, OUTCOMES, GRADED_OUTCOMES } from "./aspects.mjs";
import { isCloudModel, isClaudeModel } from "./models.mjs";
import { band, DEFAULT_COST_BANDS } from "./cost.mjs";
import { inferStoredIdentity } from "./results.mjs";
import { isSentinelModel } from "./manifest.mjs";

export function scoresPath(env = process.env) {
  return join(swarmHome(env), "model-scores.jsonl");
}

const isInt1to10 = (v) => Number.isInteger(v) && v >= 1 && v <= 10;

// `grade --init` marks every field to fill with <angle brackets>. An untouched
// one must never validate: "<lowercase ecosystem — e.g. godot>" is itself
// lowercase and non-empty, so the domain check alone would pass it.
const PLACEHOLDER_RE = /^<.*>$/s;

// One lowercase token naming the ecosystem the leaf worked in (rust, godot,
// node, python, docs); hyphens allowed inside. Composites ("rust+plans") and
// repo/task words are refused: the store once filled with the hint's own
// "this-repo" example, and nothing decomposes "rust+plans" back into rust.
const DOMAIN_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NON_DOMAINS = new Set(["this-repo", "repo", "repository", "project", "codebase", "general", "misc", "mixed", "various", "other", "unknown", "none", "code"]);
const DOMAIN_HINT = 'one lowercase token naming the language or ecosystem the leaf worked in — e.g. "rust", "godot", "node", "python", "docs"; not the repo, not the task, no "+" or "/"';

function explicitProvider(row) {
  return typeof row?.provider === "string" && row.provider.trim() ? row.provider.trim().toLowerCase() : null;
}

function identityOf(row) {
  const model = typeof row?.model === "string" ? row.model.trim() : row?.model;
  const provider = explicitProvider(row);
  const inferred = provider ? {} : inferStoredIdentity(model);
  return { provider: provider || inferred.provider || null, model, explicit: Boolean(provider) };
}

function identityKey(identity) {
  return JSON.stringify([identity.provider, identity.model]);
}

function displayIdentity(identity) {
  return identity.explicit && identity.provider ? `${identity.provider}/${identity.model}` : identity.model;
}

// Returns an array of human-readable problems; empty means valid. Errors name
// the field and the fix — a bad batch must teach in one round-trip.
export function validateRow(row) {
  const errs = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["row must be a JSON object"];

  if (typeof row.resultsDir !== "string" || !row.resultsDir.trim()) {
    errs.push("resultsDir: required, the run's absolute results directory — it is half the dedupe key, so a row without it cannot be stored");
  }
  if (typeof row.leaf !== "string" || !row.leaf.trim()) {
    errs.push("leaf: required, the task id as it appears in results/<id>.json");
  }
  const provider = explicitProvider(row);
  if (row.provider !== undefined && !provider) {
    errs.push("provider: must be a non-empty provider identifier when present");
  }
  if (typeof row.model !== "string" || !row.model.trim() || isSentinelModel(row.model) || (!provider && !(isCloudModel(row.model) || isClaudeModel(row.model)))) {
    errs.push(provider
      ? `model: must be a real provider model, not a sentinel (got ${JSON.stringify(row.model)})`
      : `model: must be a :cloud model name or a Claude tier (got ${JSON.stringify(row.model)}) — e.g. "glm-5.2:cloud" or "sonnet"`);
  }
  if (typeof row.domain !== "string" || !row.domain.trim() || PLACEHOLDER_RE.test(row.domain.trim())) {
    errs.push(`domain: required, ${DOMAIN_HINT}`);
  } else if (row.domain !== row.domain.toLowerCase().trim()) {
    // Padding is rejected, not trimmed away: `aggregate` filters on `===`, so a
    // stored " godot " would match no query and never raise anything.
    errs.push(`domain: must be lowercase with no surrounding whitespace (got ${JSON.stringify(row.domain)})`);
  } else if (!DOMAIN_RE.test(row.domain) || NON_DOMAINS.has(row.domain)) {
    errs.push(`domain: ${JSON.stringify(row.domain)} is not a domain — ${DOMAIN_HINT}`);
  }
  const outcomeOk = OUTCOMES.includes(row.outcome);
  if (!outcomeOk) {
    errs.push(`outcome: must be one of ${OUTCOMES.join(" | ")} (got ${JSON.stringify(row.outcome)})`);
  }
  if (!row.assessedBy || typeof row.assessedBy.session !== "string" || !row.assessedBy.session.trim()) {
    errs.push("assessedBy.session: required — a row must carry who graded it, never read as an operator verdict");
  }

  const graded = GRADED_OUTCOMES.includes(row.outcome);
  const grades = row.grades;
  const values = [];

  // An unrecognised outcome makes every grade rule unanswerable — whether they
  // are required or forbidden depends on it. Report the outcome and stop, so the
  // fix is one line rather than a cascade.
  if (!outcomeOk) return errs;

  if (!graded) {
    // No output, no grades. A leaf whose session died was not bad at adherence —
    // there was no adherence to observe, and the number would average in.
    if (grades !== undefined) {
      errs.push(`grades: must be absent when outcome is ${row.outcome} — you cannot grade a report that was never submitted`);
    }
  } else if (!grades || typeof grades !== "object" || Array.isArray(grades)) {
    errs.push(`grades: required when outcome is ${row.outcome} — output existed, so it is gradeable`);
  } else {
    for (const key of Object.keys(grades)) {
      if (!ASPECTS.includes(key)) {
        errs.push(`grades.${key}: not an aspect — use one of ${ASPECTS.join(" | ")}`);
      }
    }
    for (const key of UNIVERSAL) {
      // Present-but-null is the load-bearing case: an untouched --init skeleton
      // satisfies a presence-only check while shipping every grade empty.
      if (grades[key] == null) {
        errs.push(`grades.${key}: required 1-10 — the four universal aspects are graded on every leaf (got ${JSON.stringify(grades[key])})`);
      }
    }
    for (const key of ASPECTS) {
      const v = grades[key];
      if (v == null) continue; // capability aspects the leaf did not stress
      if (!isInt1to10(v)) {
        errs.push(`grades.${key}: must be an integer 1-10 (got ${JSON.stringify(v)})`);
      } else {
        values.push(v);
      }
    }
  }

  // A bad score without its reason cannot be audited later.
  const hasNote = typeof row.note === "string" && row.note.trim().length > 0;
  if (!hasNote) {
    if (values.some((v) => v <= 4)) errs.push("note: required when any grade is <= 4 — a low score must carry its reason");
    else if (row.outcome !== "completed") errs.push(`note: required when outcome is ${row.outcome}`);
  }

  return errs;
}

// Re-grading a run must REPLACE its rows, not append a second set. Keyed on
// resultsDir (the run's actual identity, printed at dispatch) — the engine
// exposes no run id.
export function dedupeKey(row) {
  // JSON-encoded pair, not a joined string: a resultsDir is an absolute path and
  // may contain any separator character you would otherwise pick.
  return JSON.stringify([row.resultsDir, row.leaf]);
}


export function readRows(path = scoresPath()) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // torn tail write from a concurrent append — skip, never abort a query
    }
  }
  return rows;
}

// The one key both sides of a graded-ness comparison go through: a store row's
// resultsDir and a runs-tree walk path. Measured in the real store, 349 of 355
// rows use forward slashes while a readdirSync+path.join walk on Windows yields
// backslashes — raw-string membership marks nearly every graded run ungraded,
// silently and permanently. Separators fold to "/", case folds (Windows paths
// are case-insensitive), a trailing separator is stripped.
// Operator decision 2026-09-12: under a runs tree, the key is just <enc>/<name>
// (the two segments after the last "runs" component) — moving SWARM_HOME or the
// machine must not orphan grades. A path with no "runs" component, or fewer than
// two segments after it, keeps the full normalised path.
// Returns null for what cannot identify a run — not a string, empty, or "."
// (a real row in the store): such a key is skipped, never guessed at.
export function canonicalRunKey(p) {
  if (typeof p !== "string") return null;
  const t = p.trim();
  if (!t || t === ".") return null;
  const normalized = t.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const segments = normalized.split("/");
  const runsIdx = segments.lastIndexOf("runs");
  if (runsIdx !== -1 && segments.length - runsIdx - 1 >= 2) {
    return `${segments[runsIdx + 1]}/${segments[runsIdx + 2]}`;
  }
  return normalized;
}

// Canonical keys of every resultsDir the store holds ANY row for. A dir is
// graded whatever the outcome — a failed leaf's no-grades row is the correct
// output for a dead leaf — and however many times it was re-graded (re-grading
// appends a superseding row; any of them names the dir). Rows whose resultsDir
// will not canonicalise contribute nothing.
export function gradedRunKeys(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    const key = canonicalRunKey(row?.resultsDir);
    if (key != null) keys.add(key);
  }
  return keys;
}

// Validate the WHOLE batch first and reject it entirely on any failure: the
// store is append-only, so a bad row is permanent.
export function appendRows(rows, path = scoresPath()) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("appendRows: no rows to append");
  const problems = [];
  rows.forEach((row, i) => {
    for (const e of validateRow(row)) problems.push(`row ${i} (${row?.leaf ?? "?"}): ${e}`);
  });
  if (problems.length) {
    const err = new Error(`refusing to append ${rows.length} row(s) — ${problems.length} validation problem(s):\n  - ${problems.join("\n  - ")}`);
    err.problems = problems;
    throw err;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows.length;
}

// Newest row per (resultsDir, leaf) — later lines win, so a re-grade replaces
// rather than double-weighting the model in every cell it touches.
export function dedupe(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(dedupeKey(row), row);
  return [...byKey.values()];
}

// Pure: rows in, cells out. Every aspect in the requested set gets an entry
// even with no rows — absence is evidence, and a silently missing row reads as
// coverage that does not exist.
export function aggregate(rows, { aspect, model, provider, domain, combineProviders = false } = {}) {
  if (aspect && !ASPECTS.includes(aspect)) {
    throw new Error(`unknown aspect ${JSON.stringify(aspect)} — use one of ${ASPECTS.join(" | ")}`);
  }
  const wanted = aspect ? [aspect] : ASPECTS;
  const scoped = dedupe(rows).filter((r) => {
    const identity = identityOf(r);
    return (!model || identity.model === model)
      && (provider === undefined || identity.provider === String(provider).toLowerCase())
      && (!domain || r.domain === domain);
  });

  return {
    aspects: wanted.map((a) => {
      const cells = new Map();
      const keyFor = (identity) => combineProviders
        ? JSON.stringify([identity.model])
        : identityKey(identity);
      const cellFor = (identity) => {
        const key = keyFor(identity);
        if (!cells.has(key)) {
          cells.set(key, {
            ...(combineProviders
              ? { providers: [] }
              : identity.explicit && identity.provider ? { provider: identity.provider } : {}),
            model: identity.model,
            n: 0,
            mean: null,
            provisional: true,
            sum: 0,
            outcomes: blankOutcomes(),
          });
        }
        const cell = cells.get(key);
        if (combineProviders) {
          if (identity.provider && !cell.providers.includes(identity.provider)) {
            cell.providers.push(identity.provider);
            cell.providers.sort();
          }
        } else if (identity.explicit && identity.provider) {
          cell.provider = identity.provider;
        }
        return cell;
      };
      for (const r of scoped) {
        const identity = identityOf(r);
        const grade = r.grades?.[a];
        // An ungraded row declared no aspects — it could not. It still counts
        // under outcomes for every cell of its model, because "an image read
        // kills the session" must be a query result, not a lost afternoon.
        const ungraded = !GRADED_OUTCOMES.includes(r.outcome);
        if (grade == null && !ungraded) continue;
        const cell = cellFor(identity);
        cell.outcomes[r.outcome] += 1;
        if (grade != null) {
          cell.n += 1;
          cell.sum += grade;
        }
      }
      const raw = [...cells.values()].map(({ sum, ...c }) => ({
        ...c,
        mean: c.n ? Number((sum / c.n).toFixed(2)) : null,
        provisional: c.n < 5,
      }));
      const prior = fairPrior(raw);
      const list = raw.map((c) => ({ ...c, weighted: shrink(c.mean, c.n, prior) }));
      // Ranked on the shrunk score: an unweighted mean lets one lucky sample head
      // the table two points clear of a forty-sample cell, which the provisional
      // tag warns about but the ordering contradicts.
      list.sort((x, y) => (y.weighted ?? -1) - (x.weighted ?? -1)
        || displayIdentity(identityOf(x)).localeCompare(displayIdentity(identityOf(y))));
      return { aspect: a, universal: UNIVERSAL.includes(a), cells: list, prior };
    }),
    filters: {
      aspect: aspect ?? null,
      model: model ?? null,
      domain: domain ?? null,
      ...(provider !== undefined && { provider: String(provider).toLowerCase() }),
    },
  };
}

function blankOutcomes() {
  return Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
}

// Virtual prior observations every cell starts with. 5 matches the provisional
// threshold, so one constant governs both: a cell needs roughly that many real
// samples before its own mean outweighs the field's.

// One combined ranking across models: the mean of the four UNIVERSAL weighted
// scores. Capability aspects stay out — they are graded only where a leaf
// stressed them, so averaging them in would punish exactly the models seated
// on hard capability work. Same definition as the seat-economics chart's
// quality axis, but owned here.
export function overall(rows, { model, provider, domain, combineProviders = false } = {}) {
  const report = aggregate(rows, { model, ...(provider !== undefined && { provider }), domain, combineProviders });
  const universals = report.aspects.filter((a) => a.universal);
  const byModel = new Map();
  for (const a of universals) {
    for (const c of a.cells) {
      const identity = identityOf(c);
      const key = combineProviders ? JSON.stringify([c.model]) : identityKey(identity);
      if (!byModel.has(key)) {
        byModel.set(key, {
          ...(combineProviders ? { providers: [] }
            : identity.explicit && identity.provider ? { provider: identity.provider } : {}),
          model: c.model,
          n: 0,
          combined: null,
          wtds: {},
          provisional: false,
          outcomes: c.outcomes,
        });
      }
      const cell = byModel.get(key);
      if (combineProviders) {
        for (const p of c.providers || (identity.provider ? [identity.provider] : [])) {
          if (p && !cell.providers.includes(p)) cell.providers.push(p);
        }
        cell.providers.sort();
      } else if (identity.explicit && identity.provider) {
        cell.provider = identity.provider;
      }
      cell.wtds[a.aspect] = c.weighted;
      cell.n = Math.max(cell.n, c.n);
      cell.provisional = cell.provisional || (c.n > 0 && c.provisional);
    }
  }
  const cells = [...byModel.values()].map((c) => {
    const got = universals.map((a) => c.wtds[a.aspect]).filter((v) => v != null);
    return { ...c, combined: got.length ? Number((got.reduce((x, y) => x + y, 0) / got.length).toFixed(2)) : null };
  });
  cells.sort((x, y) => (y.combined ?? -1) - (x.combined ?? -1)
    || displayIdentity(identityOf(x)).localeCompare(displayIdentity(identityOf(y))));
  return { cells, universals: universals.map((a) => a.aspect), filters: report.filters };
}

export const PRIOR_WEIGHT = 5;

// The unweighted mean of per-model means — NEVER the mean of all rows.
//
// This is the whole fairness argument. Rows accumulate where routing already
// sends work, so a row-weighted prior IS the most-dispatched model's mean, and
// shrinking a rarely-used model toward it would pull it toward its busiest
// rival — importing exactly the usage bias the store exists to remove. One
// model, one vote.
export function fairPrior(cells) {
  const means = cells.map((c) => c.mean).filter((m) => m != null);
  if (!means.length) return null;
  return means.reduce((a, b) => a + b, 0) / means.length;
}

// Empirical-Bayes shrinkage toward the prior. A thin cell is pulled most; a
// well-evidenced one barely moves. No cell is dropped or penalised for being
// rare — it simply has to earn its position.
export function shrink(mean, n, prior, k = PRIOR_WEIGHT) {
  if (mean == null) return null;
  if (prior == null) return mean;
  return Number(((n * mean + k * prior) / (n + k)).toFixed(2));
}

// The domination frontier — quality against cost WITHOUT collapsing the two
// into one ratio. A model is dominated iff another participant is strictly
// better (higher wtd) AND strictly cheaper (lower multiplier); everyone else
// is on the frontier. A ratio fails both directions at once: it lets one cheap
// graded leaf outrank a well-evidenced model, and it silently ranks an
// expensive model low without naming the cheaper model that beat it.
// A model with no multiplier — a Claude tier the history has never priced, or
// a measured-but-thin one — is UNMEASURED: neither on the frontier nor
// dominated, and it dominates nothing. Missing is not 0 (free) and not
// Infinity (dear); absence is not evidence in either direction.
export function frontier(rows, costs, { aspect, model, provider, domain, costDomain, bands = DEFAULT_COST_BANDS } = {}) {
  const costOf = new Map();
  for (const cost of costs || []) {
    const identity = identityOf(cost);
    const key = identityKey(identity);
    const list = costOf.get(key) || [];
    list.push({
      ...cost,
      ...identity,
      costDomain: cost.costDomain || `${identity.provider || "legacy"}:${cost.unit || "meter-points"}:${cost.classification || "legacy"}`,
    });
    costOf.set(key, list);
  }
  const cells = aspect
    ? aggregate(rows, { aspect, model, ...(provider !== undefined && { provider }), domain }).aspects[0].cells
    : overall(rows, { model, ...(provider !== undefined && { provider }), domain }).cells;
  // The aggregate's own order is the return order: quality-ranked, never
  // re-ranked by cost — the frontier marks rows, it does not reorder them.
  const entries = cells.map((c) => ({
    ...(c.provider ? { provider: c.provider } : {}),
    model: c.model,
    wtd: aspect ? c.weighted : c.combined,
    n: c.n,
    multiplier: null,
    band: null,
    onFrontier: false,
    dominatedBy: null,
  }));
  const costFor = (entry) => {
    const identity = identityOf(entry);
    const candidates = (costOf.get(identityKey(identity)) || [])
      .filter((cost) => costDomain === undefined || cost.costDomain === costDomain);
    if (!candidates.length) return null;
    const domains = new Set(candidates.map((cost) => cost.costDomain));
    if (costDomain === undefined && domains.size > 1) return null;
    return candidates.find((cost) => cost.mult != null) || candidates[0];
  };
  for (const entry of entries) {
    const cost = costFor(entry);
    if (!cost) continue;
    entry.multiplier = cost.mult ?? null;
    entry.costDomain = cost.costDomain;
    for (const field of ["unit", "source", "classification", "asOf", "value", "baseModel"]) {
      if (cost[field] !== undefined) entry[field] = cost[field];
    }
  }
  const participants = entries.filter((e) => e.wtd != null && e.multiplier != null);
  for (const e of participants) {
    // The first dominator in aggregate order is the highest-quality one, so a
    // dominated row names the best model that beat it, not just any.
    const dominator = participants.find((p) => p !== e && p.costDomain === e.costDomain && p.wtd > e.wtd && p.multiplier < e.multiplier);
    if (dominator) e.dominatedBy = displayIdentity(identityOf(dominator));
    else e.onFrontier = true;
  }
  for (const e of participants) e.band = band(e.multiplier, bands);
  return entries;
}
