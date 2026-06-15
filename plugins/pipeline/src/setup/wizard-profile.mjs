// Idempotent profile/rc-file merge for the PATH-alias step.
//
// Why: prior wizard runs (pre-resolver shim) wrote a `function pipeline { ... }`
// body hardcoded to a specific install path. Re-running setup must REPLACE
// that block so the function points at the self-resolving shim — blind append
// leaves the stale block ahead of any new definition.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MARKER = "# pipeline (added by setup)";

function _stripMarkerBlocks(text) {
  // Matches canonical marker and variant forms (e.g. "# pipeline (added by setup — PS 5.1)").
  return text.replace(/(?:^|\n)# pipeline \(added by setup[^\n]*\)(?:\n[^\n]*)?/g, "");
}

function _trimTrailing(text) {
  return text.replace(/\n+$/, "");
}

// Merge the new `function pipeline { ... }` line into an existing PS profile.
// Strips any prior marker block (including variant markers) and any orphan
// single-line `function pipeline { ... }` (the only form this wizard has ever emitted).
export function mergePsProfile(oldText, fnLine) {
  let s = (oldText || "").replace(/\r\n/g, "\n");
  s = _stripMarkerBlocks(s);
  s = s.replace(/^function\s+pipeline\s*\{[^\n}]*\}\s*$/gm, "");
  s = _trimTrailing(s);
  const sep = s ? "\n\n" : "";
  return `${s}${sep}${MARKER}\n${fnLine}\n`;
}

// Merge the new `alias pipeline=...` line into an existing bash/zsh rc file.
// Strips any prior marker block and any orphan `alias pipeline=...` line.
export function mergeUnixRc(oldText, aliasLine) {
  let s = (oldText || "").replace(/\r\n/g, "\n");
  s = _stripMarkerBlocks(s);
  s = s.replace(/^alias\s+pipeline=.*$/gm, "");
  s = _trimTrailing(s);
  const sep = s ? "\n\n" : "";
  return `${s}${sep}${MARKER}\n${aliasLine}\n`;
}

// Write fnLine to all resolved PowerShell profiles.
// When profiles is empty, surfaces the function for manual installation.
export function applyPsProfiles(profiles, fnLine, say = console.log) {
  if (profiles.length === 0) {
    say(`No PowerShell found; cannot write function. Add this to your shell profile manually:\n  ${fnLine}`);
    return;
  }
  for (const { exe, path } of profiles) {
    try {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
      let existing = "";
      try { existing = readFileSync(path, "utf8"); } catch {}
      writeFileSync(path, mergePsProfile(existing, fnLine));
      say(`✓ Wired pipeline function in ${exe} profile: ${path}`);
    } catch (e) {
      say(`✗ Could not write ${exe} profile (${path}): ${e.message}`);
      say(`  Add manually:\n  ${fnLine}`);
    }
  }
}
