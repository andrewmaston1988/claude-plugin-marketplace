import { resolve, sep } from "node:path";

// Paths that differ only in separator style, case (win32) or a trailing/doubled
// separator are one root. Exported so the intersection compares the same way this
// check does — raw string equality silently drops C:\code against C:/code.
export function normalizeForCompare(path) {
  let normalized = resolve(path).replace(/[\\/]+/g, sep);
  if (normalized.length > 1 && (normalized.endsWith("\\") || normalized.endsWith("/"))) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// True when dir is root or lives underneath it (path-boundary aware).
export function isUnderRoot(dir, root) {
  const d = normalizeForCompare(dir);
  const r = normalizeForCompare(root);
  return d === r || d.startsWith(r + sep);
}
