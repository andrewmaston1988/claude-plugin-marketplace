// `swarm perf` — the aspect x model table and its --overall ranking. Split out of
// the CLI entry point so that file can carry the in-process sink without growing.
import { getConfig } from "../src/config.mjs";
import { modelRoster } from "../src/roster.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { meterCostRows, costSettings } from "../src/cost-settings.mjs";
import { launchableRoster } from "../src/seat-check.mjs";
import { dim, out } from "../src/ui.mjs";

// `--name value`, and nothing else: the flag reader every command module shares.
export function getFlag(name, args) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}

export async function cmdPerf(rest) {
  const { readRows, hideDisabledRows, aggregate, overall, dedupe, scoresPath, frontier, PRIOR_WEIGHT } = await import("../src/scores.mjs");
  const { outcomeTail, infraFooter } = await import("../src/perf-tail.mjs");
  const aspect = getFlag("aspect", rest);
  const model = getFlag("model", rest);
  const domain = getFlag("domain", rest);
  const cfg = getConfig();
  const path = scoresPath();
  const registry = defaultProviderRegistry(), rows = hideDisabledRows(readRows(path), cfg, registry, modelRoster({ config: cfg, registry }).models);
  const report = aggregate(rows, { aspect, model, domain, combineProviders: true });
  const costs = await meterCostRows();
  const settings = await costSettings(cfg);
  const { bands } = settings;
  // A model is dominated when another is at least as good on both and better
  // on one; `*` marks the frontier. Unmeasured cost renders "—": blank would
  // read as dominated when the truth is unknown.
  const costCols = (f) => ({
    cost: f && f.band != null ? "$".repeat(f.band) : "—",
    frontier: f ? (f.onFrontier ? "*" : f.dominatedBy ? `dom ${f.dominatedBy}` : "—") : "—",
  });
  const byModel = (entries) => {
    const grouped = new Map();
    for (const entry of entries) {
      const list = grouped.get(entry.model) || [];
      list.push(entry);
      grouped.set(entry.model, list);
    }
    return new Map([...grouped].map(([name, list]) => [name, list.length === 1 ? list[0] : { providerLocal: true }]));
  };
  const LEGEND = "    cost $/$$/$$$ = meter weight band vs the cheapest measured model (swarm cost) · * on the quality/cost frontier · dom <model> = a model at least as good and as cheap, better on one, exists · provider-local = multiple providers for this model · — unmeasured, not free · seat from the frontier, never by quality÷cost";
  const filters = Object.entries(report.filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" · ");
  // Lines and rows differ after a re-grade: the store is append-only and the
  // newest row per (resultsDir, leaf) wins, so say both rather than let the raw
  // line count read as coverage.
  const live = dedupe(rows).length;
  const counted = live === rows.length ? `${live} row(s)` : `${live} row(s) (${rows.length} lines, re-grades superseded)`;
  out(`model scores: ${counted} · ${path}`);
  if (filters) out(`filters: ${filters}`);
  out("");
  if (rest.includes("--overall")) {
    const o = (await import("../src/perf-overall.mjs")).perfOverall({ cfg, roster: await launchableRoster(cfg), rows, costRows: costs, ...settings, model, domain, out });
    const costByModel = byModel(frontier(rows, costs, { model, domain, bands }));
    const w = Math.max(5, ...o.cells.map((c) => c.model.length));
    out(`    ${"model".padEnd(w)}    n  overall  ${o.universals.map((a) => a.slice(0, 5).padStart(5)).join("  ")}  cost  frontier`);
    for (const c of o.cells) {
      const cols = o.universals.map((a) => (c.wtds[a] == null ? "—" : c.wtds[a].toFixed(2)).padStart(5)).join("  ");
      const candidate = costByModel.get(c.model);
      const { cost, frontier: fm } = candidate?.providerLocal
        ? { cost: "—", frontier: "provider-local" }
        : costCols(candidate);
      const flag = (c.combined == null ? dim("  [no grades — outcomes only]") : c.provisional ? dim("  [provisional n<5]") : "")
        + (c.supersededBy ? dim(`  [superseded by ${c.supersededBy}]`) : "");
      const tail = outcomeTail(c, report);
      out(`    ${c.model.padEnd(w)}  ${String(c.n).padStart(3)}  ${(c.combined == null ? "—" : c.combined.toFixed(2)).padStart(7)}  ${cols}  ${cost.padEnd(4)}${fm}${flag}${tail ? dim(tail) : ""}`);
    }
    out(dim("    overall = mean of the four universal weighted scores; capability aspects excluded"));
    out(dim(LEGEND));
    return 0;
  }
  // A column's n is not the model's n: one `search` row on a model with 25
  // overall reads as a gap seat until the overall n sits beside it.
  const overallN = new Map(overall(rows, { model, domain, combineProviders: true }).cells.map((c) => [c.model, c.n]));
  for (const a of report.aspects) {
    out(`${a.aspect}${a.universal ? dim("  (universal)") : ""}`);
    if (!a.cells.length) {
      // Absence is evidence: an aspect nothing has been graded on is a finding,
      // never a row to hide.
      out(dim("    n=0 — no rows"));
      continue;
    }
    const costByModel = byModel(frontier(rows, costs, { aspect: a.aspect, model, domain, bands }));
    const w = Math.max(...a.cells.map((c) => c.model.length));
    for (const c of a.cells) {
      const mean = c.mean == null ? "—" : c.mean.toFixed(2);
      const wtd = c.weighted == null ? "—" : c.weighted.toFixed(2);
      const candidate = costByModel.get(c.model);
      const { cost, frontier: fm } = candidate?.providerLocal
        ? { cost: "—", frontier: "provider-local" }
        : costCols(candidate);
      const flag = c.n === 0 ? dim("  [no grades — outcomes only]") : c.provisional ? dim("  [provisional n<5]") : "";
      const tail = outcomeTail(c, report, { includeInfra: false });
      const total = overallN.get(c.model);
      const totalPart = Number.isFinite(total) ? `  overall n=${total}` : "";
      out(`    ${c.model.padEnd(w)}  n=${String(c.n).padStart(3)}${totalPart}  mean ${mean.padStart(5)}  wtd ${wtd.padStart(5)}  cost ${cost.padEnd(3)}  ${fm}${flag}${tail ? dim(tail) : ""}`);
    }
    // Both columns show, ranked on wtd: the raw mean is the evidence, the
    // weighted score is what it is worth given how much of it there is.
    if (a.prior != null) out(dim(`    prior ${a.prior.toFixed(2)} (mean of per-model means; k=${PRIOR_WEIGHT})`));
  }
  for (const line of infraFooter(report, LEGEND)) out(line);
  return 0;
}
