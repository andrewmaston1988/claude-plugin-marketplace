// Model capability scores — append-only JSONL at ~/.swarm/model-scores.jsonl.
//
// One row per graded leaf. Line-atomic appends, so concurrent swarms cannot
// corrupt the store and no run dirties the repo. The aggregator is pure — it
// takes rows, not a path — so it tests without fixtures.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { swarmHome } from "./config.mjs";
import { UNIVERSAL, ASPECTS, OUTCOMES, GRADED_OUTCOMES } from "./aspects.mjs";

export function scoresPath(env = process.env) {
  return join(swarmHome(env), "model-scores.jsonl");
}

// Only :cloud leaves are graded — the Claude tiers are known quantities. Both
// separators occur in the roster (discovery derives names from bare tags), so
// the suffix check matches what probeTopModels already treats as cloud.
const CLOUD_RE = /(:|-)cloud$/i;

const isInt1to10 = (v) => Number.isInteger(v) && v >= 1 && v <= 10;

// `grade --init` marks every field to fill with <angle brackets>. An untouched
// one must never validate: "<lowercase ecosystem — e.g. godot>" is itself
// lowercase and non-empty, so the domain check alone would pass it.
const PLACEHOLDER_RE = /^<.*>$/s;

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
  if (typeof row.model !== "string" || !CLOUD_RE.test(row.model)) {
    errs.push(`model: must be a :cloud model name (got ${JSON.stringify(row.model)}) — Claude tiers are out of scope for this store`);
  }
  if (typeof row.domain !== "string" || !row.domain.trim() || PLACEHOLDER_RE.test(row.domain.trim())) {
    errs.push('domain: required, free lowercase text naming the ecosystem — e.g. "godot", "rust", "this-repo"');
  } else if (row.domain !== row.domain.toLowerCase()) {
    errs.push(`domain: must be lowercase (got ${JSON.stringify(row.domain)})`);
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
export function aggregate(rows, { aspect, model, domain } = {}) {
  if (aspect && !ASPECTS.includes(aspect)) {
    throw new Error(`unknown aspect ${JSON.stringify(aspect)} — use one of ${ASPECTS.join(" | ")}`);
  }
  const wanted = aspect ? [aspect] : ASPECTS;
  const scoped = dedupe(rows).filter((r) =>
    (!model || r.model === model) && (!domain || r.domain === domain));

  return {
    aspects: wanted.map((a) => {
      const cells = new Map();
      const cellFor = (m) => {
        if (!cells.has(m)) {
          cells.set(m, { model: m, n: 0, mean: null, provisional: true, sum: 0, outcomes: blankOutcomes() });
        }
        return cells.get(m);
      };
      for (const r of scoped) {
        const grade = r.grades?.[a];
        // An ungraded row declared no aspects — it could not. It still counts
        // under outcomes for every cell of its model, because "an image read
        // kills the session" must be a query result, not a lost afternoon.
        const ungraded = !GRADED_OUTCOMES.includes(r.outcome);
        if (grade == null && !ungraded) continue;
        const cell = cellFor(r.model);
        cell.outcomes[r.outcome] += 1;
        if (grade != null) {
          cell.n += 1;
          cell.sum += grade;
        }
      }
      const list = [...cells.values()].map(({ sum, ...c }) => ({
        ...c,
        mean: c.n ? Number((sum / c.n).toFixed(2)) : null,
        provisional: c.n < 5,
      }));
      list.sort((x, y) => (y.mean ?? -1) - (x.mean ?? -1) || x.model.localeCompare(y.model));
      return { aspect: a, universal: UNIVERSAL.includes(a), cells: list };
    }),
    filters: { aspect: aspect ?? null, model: model ?? null, domain: domain ?? null },
  };
}

function blankOutcomes() {
  return Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
}
