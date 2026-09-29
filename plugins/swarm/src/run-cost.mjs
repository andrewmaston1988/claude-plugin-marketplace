// A leaf's cost in its seat's own unit, never summed across units. Billed means the summary
// row's real-key `costUsd`: a result file's `costUsd` is an Anthropic-rate figure even for a
// subscription or `:cloud` leaf, so it is never read. Unknown is blank, never zero.
import { statSync } from "node:fs";
import { join } from "node:path";
import { resolveRatePrice } from "./rate-card-parse.mjs";
import { rateCards, rateCardStorePath } from "./rate-card.mjs";
import { swarmHome } from "./config.mjs";
import { cloudSuffixOf } from "./cost-settings.mjs";
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
// Named with the configured suffix, so a leaf's model (which carries it) finds its row.
function meterRowsFor(home, cloudSuffix) {
  const path = join(home, "usage-history.jsonl");
  let key = `${cloudSuffix}:none`;
  try { const s = statSync(path); key = `${cloudSuffix}:${s.mtimeMs}:${s.size}`; } catch { /* no history yet */ }
  const hit = meterCache.get(path);
  if (hit?.key === key) return hit.rows;
  const rows = ollamaCloudCostRows(readSnapshots(path), cloudSuffix);
  meterCache.set(path, { key, rows });
  return rows;
}

export const costDeps = (home, cloudSuffix) => ({
  cards: rateCards(rateCardStorePath({ ...process.env, SWARM_HOME: home })),
  meterRows: meterRowsFor(home, cloudSuffix),
});

// The one call every surface makes: rows in, the text beside the work tokens out.
export const costText = (rows, { home, money, cloudSuffix }) => formatCost(runCost(rows, costDeps(home, cloudSuffix)), { money });

// The roster footer's callback: tasks in, cost text out, for the configured money setting.
export const costOfFor = (cfg, home = swarmHome()) => (rows) => costText(rows, { home, money: cfg.display?.money === true, cloudSuffix: cloudSuffixOf(cfg) });
