// What a leaf or a run cost, priced in the unit its seat is actually metered in and printed
// beside the work tokens. Three units, never added together:
//   - billed dollars: the summary row's `costUsd`, which the engine only records for a
//     real-key leaf. A result file's `costUsd` is never read — the Claude runner reports an
//     Anthropic-rate price for a subscription leaf and for a `:cloud` one, and neither is a bill.
//   - api-equivalent dollars: the rate card's $/Mtok applied to the four token buckets.
//   - a share of the weekly quota: a `:cloud` leaf's turns (one request each) x the meter's
//     points per request.
// Unknown is blank, never zero. Dollars print only when the operator set `display.money`.
import { statSync } from "node:fs";
import { join } from "node:path";
import { resolveRatePrice } from "./rate-card-parse.mjs";
import { rateCards } from "./rate-card.mjs";
import { swarmHome } from "./config.mjs";
import { ollamaCloudCostRows, readSnapshots } from "./cost.mjs";

const isCloud = (row) => row.provider === "ollama" || /:cloud$/.test(row.model || "");

export function leafCost(row, { cards, meterRows }) {
  if (isCloud(row)) {
    const rate = meterRows.find((m) => m.model === row.model)?.ptsPerReq;
    return row.numTurns > 0 && rate > 0 ? { weekPct: row.numTurns * rate } : {};
  }
  if (row.costUsd != null) return { usd: row.costUsd, usdKind: "billed" };
  const price = resolveRatePrice(cards[row.provider]?.prices ?? {}, row.model ?? "")?.price;
  const t = row.tokens;
  if (!price || !t) return {};
  const usd = ((t.input || 0) * price.input
    + (t.cacheCreation || 0) * (price.cacheWrite ?? price.input)
    + (t.cacheRead || 0) * (price.cachedInput ?? price.input)
    + (t.output || 0) * price.output) / 1e6;
  return usd > 0 ? { usd, usdKind: "api-equivalent" } : {};
}

// Each unit summed on its own. The dollars are billed only when every priced leaf was.
export function runCost(rows, deps) {
  let usd; let weekPct; let billed = true;
  for (const row of rows) {
    const c = leafCost(row, deps);
    if (c.usd != null) { usd = (usd ?? 0) + c.usd; if (c.usdKind !== "billed") billed = false; }
    if (c.weekPct != null) weekPct = (weekPct ?? 0) + c.weekPct;
  }
  return {
    ...(usd != null && { usd, usdKind: billed ? "billed" : "api-equivalent" }),
    ...(weekPct != null && { weekPct }),
  };
}

const trimZero = (s) => s.replace(/\.0$/, "");
// Four places under a cent, so a small ask reads as its size rather than as free.
const fmtUsd = (usd) => `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
const fmtPct = (pct) => (pct < 0.05 ? "<0.1" : trimZero(pct.toFixed(1)));

// Exactly `money === true`: a truthy string in a hand-edited config must not switch dollars on.
export function formatCost(cost, { money = false } = {}) {
  const parts = [];
  if (money === true && cost.usd != null) parts.push(cost.usdKind === "billed" ? fmtUsd(cost.usd) : `≈${fmtUsd(cost.usd)} api-eq`);
  if (cost.weekPct != null) parts.push(`${fmtPct(cost.weekPct)}% of week`);
  return parts.join(" · ");
}

// The meter rows are a derivation over the whole usage history, so they are cached against
// the file's stamp: the live roster prices on every repaint.
const meterCache = new Map();
function meterRowsFor(home) {
  const path = join(home, "usage-history.jsonl");
  let key = "none";
  try { const s = statSync(path); key = `${s.mtimeMs}:${s.size}`; } catch { /* no history yet */ }
  const hit = meterCache.get(path);
  if (hit?.key === key) return hit.rows;
  const rows = ollamaCloudCostRows(readSnapshots(path));
  meterCache.set(path, { key, rows });
  return rows;
}

export const costDeps = (home) => ({ cards: rateCards(), meterRows: meterRowsFor(home) });

// The one call every surface makes: rows in, the text beside the work tokens out.
export const costText = (rows, { home, money }) => formatCost(runCost(rows, costDeps(home)), { money });

// The roster footer's callback: tasks in, cost text out, for the configured money setting.
export const costOfFor = (cfg, home = swarmHome()) => (rows) => costText(rows, { home, money: cfg.display?.money === true });
