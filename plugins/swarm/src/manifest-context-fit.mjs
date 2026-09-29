// Capacity gate: a seat whose declared context window cannot hold half its
// mustRead reads is refused at validate, before the run spends on it.
import { readFileSync, statSync } from "node:fs";
import { resolveMustRead, mergeIntervals } from "./coverage.mjs";
import { fmtCtx } from "./model-row.mjs";
import { formatTokens } from "./results.mjs";

export const BYTES_PER_TOKEN = 4;
// The other half is left for tool-call framing, the leaf's own output and a schema re-ask.
export const CONTEXT_FIT_SHARE = 0.5;

const windowOf = (cache, provider, model) => {
  const n = (cache || []).find((r) => r?.provider === provider && r?.model === model)?.contextLength;
  return n > 0 ? n : undefined;
};

// Raw bytes of the 1-based inclusive `ranges` of `path`, line terminators included.
function rangeBytes(path, ranges) {
  const rows = readFileSync(path, "utf8").split(/(?<=\n)/);
  let bytes = 0;
  for (const [a, b] of mergeIntervals(ranges)) {
    for (let i = Math.max(a, 1); i <= Math.min(b, rows.length); i++) bytes += Buffer.byteLength(rows[i - 1]);
  }
  return bytes;
}

// { bytes, partial } — partial means something the leaf will read could not be sized here.
function sizeReads(t) {
  let partial = false;
  const substitute = (s) => {
    if (!/\{\{resultPath:/.test(s)) return s;
    partial = true; // the resolver leaves no trace of a skipped entry
    return null;
  };
  const { required, missed } = resolveMustRead(t.mustRead, { cwd: t.cwd, substitute });
  if (missed.length) partial = true;
  const byPath = new Map();
  for (const r of required) {
    const g = byPath.get(r.path) || { whole: false, ranges: [] };
    g.whole ||= r.whole;
    g.ranges.push(...r.ranges);
    byPath.set(r.path, g);
  }
  let bytes = 0;
  for (const [path, g] of byPath) {
    try {
      bytes += g.whole ? statSync(path).size : rangeBytes(path, g.ranges);
    } catch {
      partial = true;
    }
  }
  return { bytes, partial };
}

export function validateContextFit(tasks, { cache, errors, label }) {
  for (const t of tasks) {
    if (!Array.isArray(t.mustRead) || !t.provider) continue;
    const seats = [
      { provider: t.provider, model: t.model, name: label(t) },
      ...(t.fallbackModel && t.fallbackProvider ? [{ provider: t.fallbackProvider, model: t.fallbackModel, name: `${label(t)} fallback` }] : []),
    ].map((s) => ({ ...s, ctx: windowOf(cache, s.provider, s.model) })).filter((s) => s.ctx);
    if (!seats.length) continue;
    const { bytes: readBytes, partial } = sizeReads(t);
    if (readBytes === 0) continue;
    const bytes = readBytes + Buffer.byteLength(String(t.prompt ?? ""));
    const tokens = bytes / BYTES_PER_TOKEN;
    for (const s of seats) {
      const budget = s.ctx * CONTEXT_FIT_SHARE;
      if (tokens <= budget) continue;
      errors.push(
        `${s.name}: seats '${s.model}' (${fmtCtx(s.ctx)}), but its mustRead is ${partial ? "≥" : "~"}${formatTokens(Math.round(tokens))} tokens ` +
        `(${Math.round(bytes / 1000)} KB) — over the ${Math.round(CONTEXT_FIT_SHARE * 100)}% budget (${formatTokens(Math.floor(budget / 1000) * 1000)}). ` +
        `Seat a larger-context model ('swarm models' prints ctx per row), or split the reads across more lanes.`);
    }
  }
}
