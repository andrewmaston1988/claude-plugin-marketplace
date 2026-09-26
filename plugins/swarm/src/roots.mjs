import * as nodePath from "node:path";

// Paths that differ only in separator style, case (win32) or a trailing/doubled
// separator are one root. Exported so the intersection compares the same way this
// check does — raw string equality silently drops C:\code against C:/code.
// `_path` is a test seam only: resolve("/") on win32 is the current drive root, so the
// POSIX filesystem root is otherwise unreachable from a Windows runner.
export function normalizeForCompare(path, { _path = nodePath } = {}) {
  let normalized = _path.resolve(path).replace(/[\\/]+/g, _path.sep);
  if (normalized.length > 1 && (normalized.endsWith("\\") || normalized.endsWith("/"))) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// True when dir is root or lives underneath it (path-boundary aware).
export function isUnderRoot(dir, root, { _path = nodePath } = {}) {
  const d = normalizeForCompare(dir, { _path });
  const r = normalizeForCompare(root, { _path });
  // A root that already ends in the separator is its own boundary: "/" + "/" is "//",
  // which matches no descendant.
  return d === r || d.startsWith(r.endsWith(_path.sep) ? r : r + _path.sep);
}
