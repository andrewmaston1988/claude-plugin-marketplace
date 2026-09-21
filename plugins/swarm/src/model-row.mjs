// Per-model roster row rendering for `swarm models`.

import { declaredEfforts } from "./models.mjs";

function fmtParams(n) {
  return n >= 1e12 ? `${(n / 1e12).toFixed(1)}T` : `${Math.round(n / 1e9)}B`;
}

function fmtCtx(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M ctx` : `${Math.round(n / 1e3)}k ctx`;
}

export function modelLine(m) {
  const name = m.displayModel || m.model;
  const line = m.description ? `${name} — ${m.description}` : name;
  if (!(m.parameterCount > 0) && !(m.contextLength > 0)) return line;
  const size = m.parameterCount > 0 ? fmtParams(m.parameterCount) : "size unreported";
  return `${line} (${[size, ...(m.contextLength > 0 ? [fmtCtx(m.contextLength)] : [])].join(", ")})`;
}

// The declared-efforts cell. The list is read through declaredEfforts — the
// same reading `swarm validate` rejects pins from — never the raw cache field.
// A model the roster carries that declares no efforts says so in words; a
// model with no roster row at all is unknown — the two states differ.
export function effortsCell(row, cache) {
  const declared = declaredEfforts(row.model, row.provider, cache);
  if (declared?.efforts?.length) {
    return declared.defaultEffort ? `${declared.efforts.join("/")} (default ${declared.defaultEffort})` : declared.efforts.join("/");
  }
  if (declared?.defaultEffort) return `default ${declared.defaultEffort}`;
  // Presence mirrors declaredEfforts' bare-model cache match; for a roster row
  // rendered from the cache this is always true.
  const looked = (cache || []).some((candidate) => candidate?.model === row.model);
  return looked ? "declares none" : "unknown";
}