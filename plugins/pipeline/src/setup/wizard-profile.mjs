// Idempotent profile/rc-file merge for the PATH-alias step.
//
// Why: prior wizard runs (pre-resolver shim) wrote a `function pipeline { ... }`
// body hardcoded to a specific install path. Re-running setup must REPLACE
// that block so the function points at the self-resolving shim — blind append
// leaves the stale block ahead of any new definition.

export const MARKER = "# pipeline (added by setup)";

function _stripMarkerBlocks(text, escapedMarker) {
  // Marker line + optional following line (the function/alias body).
  return text.replace(new RegExp(`(?:^|\\n)${escapedMarker}(?:\\n[^\\n]*)?`, "g"), "");
}

function _trimTrailing(text) {
  return text.replace(/\n+$/, "");
}

function _escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Merge the new `function pipeline { ... }` line into an existing PS profile.
// Strips any prior marker block and any orphan single-line `function pipeline { ... }`
// (the only form this wizard has ever emitted).
export function mergePsProfile(oldText, fnLine) {
  let s = (oldText || "").replace(/\r\n/g, "\n");
  s = _stripMarkerBlocks(s, _escape(MARKER));
  s = s.replace(/^function\s+pipeline\s*\{[^\n}]*\}\s*$/gm, "");
  s = _trimTrailing(s);
  const sep = s ? "\n\n" : "";
  return `${s}${sep}${MARKER}\n${fnLine}\n`;
}

// Merge the new `alias pipeline=...` line into an existing bash/zsh rc file.
// Strips any prior marker block and any orphan `alias pipeline=...` line.
export function mergeUnixRc(oldText, aliasLine) {
  let s = (oldText || "").replace(/\r\n/g, "\n");
  s = _stripMarkerBlocks(s, _escape(MARKER));
  s = s.replace(/^alias\s+pipeline=.*$/gm, "");
  s = _trimTrailing(s);
  const sep = s ? "\n\n" : "";
  return `${s}${sep}${MARKER}\n${aliasLine}\n`;
}
