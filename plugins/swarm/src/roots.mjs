import { resolve, sep } from "node:path";

function normalizeForCompare(path) {
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
