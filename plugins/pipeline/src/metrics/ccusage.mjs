// ccusage shell-out wrapper — 3-retry loop, graceful null fallback on failure.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 90_000;

async function _runCcusage(args) {
  const { stdout } = await execFileAsync("bunx", ["ccusage", ...args], {
    timeout: TIMEOUT_MS,
  });
  return stdout;
}

/**
 * Fetch daily ccusage data for a date range (YYYYMMDD strings).
 * Retries up to 3 times on timeout. Returns array of daily rows, or null on failure.
 */
export async function getCcusageRangeData(sinceDate, untilDate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const t0 = Date.now();
      const stdout = await _runCcusage([
        "daily", "--json", "--since", sinceDate, "--until", untilDate, "--timezone", "UTC",
      ]);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const response = JSON.parse(stdout);
      if (response && typeof response === "object" && Array.isArray(response.daily)) {
        process.stdout.write(`ccusage: attempt ${attempt + 1}/3, ${elapsed}s, ${sinceDate}..${untilDate}\n`);
        return response.daily;
      }
      return null;
    } catch (err) {
      const isTimeout = err.code === "ETIMEDOUT" || err.killed;
      if (isTimeout) {
        process.stdout.write(`ccusage: attempt ${attempt + 1}/3 timed out (90s), ${sinceDate}..${untilDate}\n`);
        if (attempt < 2) continue;
        return null;
      }
      // JSON parse error, file not found, non-zero exit, etc.
      return null;
    }
  }
  return null;
}

/**
 * Fetch daily ccusage data for a single date (YYYYMMDD).
 * Returns {cache_create_tokens, cache_read_tokens, total_cost, model_breakdowns, ...} or null.
 */
export async function getCcusageDailyData(dateStr) {
  const rows = await getCcusageRangeData(dateStr, dateStr);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    cache_create_tokens: row.cacheCreationTokens ?? 0,
    cache_read_tokens: row.cacheReadTokens ?? 0,
    input_tokens: row.inputTokens ?? 0,
    output_tokens: row.outputTokens ?? 0,
    total_cost: row.totalCost ?? 0,
    models_used: row.modelsUsed ?? [],
    model_breakdowns: row.modelBreakdowns ?? [],
    data_source: "ccusage",
  };
}

/**
 * Fetch per-session ccusage data for a given date. Returns session array or null.
 */
export async function getCcusageSessionData(dateStr) {
  try {
    const stdout = await _runCcusage([
      "session", "--json", "--since", dateStr, "--until", dateStr,
    ]);
    const raw = JSON.parse(stdout);
    const sessions = (raw && typeof raw === "object") ? (raw.sessions ?? raw) : raw;
    return Array.isArray(sessions) && sessions.length > 0 ? sessions : null;
  } catch {
    return null;
  }
}

const _SONNET_46_PRICING = {
  input:          3.00 / 1_000_000,
  output:        15.00 / 1_000_000,
  cache_read:     0.30 / 1_000_000,
  cache_creation: 3.75 / 1_000_000,
};

/**
 * Estimate spend when ccusage is unavailable (Sonnet 4.6 cache rates).
 * Excludes output tokens — actual spend will be higher.
 */
export function estimateSpendFallback(cacheCreateTokens, cacheReadTokens) {
  return (
    cacheCreateTokens * _SONNET_46_PRICING.cache_creation +
    cacheReadTokens   * _SONNET_46_PRICING.cache_read
  );
}

/**
 * Estimate tokens based on session type and duration (fallback when ccusage unavailable).
 * Returns {create_tokens_est, read_tokens_est, estimation_method} or null if too short.
 */
export function estimateTokens(durationSeconds, commandType, filesIndexed = 20) {
  const basePerMin = {
    dev:          125_000,
    research:      95_000,
    test:          45_000,
    queue:         18_000,
    merge:        110_000,
    orchestrator:  88_000,
  };
  if (durationSeconds < 30) return null;
  const minPerMinute = durationSeconds / 60;
  let createTokensEst = (basePerMin[commandType] ?? 100_000) * minPerMinute;
  if (filesIndexed > 20) {
    createTokensEst *= (1 + (filesIndexed - 20) * 0.02);
  }
  return {
    create_tokens_est: Math.trunc(createTokensEst),
    read_tokens_est:   Math.trunc(createTokensEst * 30),
    estimation_method: "formula",
  };
}
