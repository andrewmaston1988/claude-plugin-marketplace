/**
 * pipeline-query.mjs — read one field from a project's pipeline row.
 *
 * The merge SKILL.md carried this as an inline `node -e` one-liner transcribed
 * three times (target_branch, rebase_required, plan_file). Each copy wrapped the
 * parse in `try{}catch{}` and wrote an empty string on failure, so a malformed
 * row read the same as a blank value — and the target-branch fallback keys on
 * exactly that distinction.
 */
import { spawnSync } from "node:child_process";

// `pipeline` is a .cmd shim on Windows, which Node refuses to spawn directly
// (EINVAL) and cannot find without an extension (ENOENT). Route through cmd.exe
// with the arguments still passed as an array, so nothing is concatenated into a
// shell string — `shell: true` would do that, unescaped (DEP0190).
export function pipelineSpawn(args, opts = {}) {
  const base = { encoding: "utf8", windowsHide: true, ...opts };
  return process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "pipeline", ...args], base)
    : spawnSync("pipeline", args, base);
}

// Parse `pipeline rows --format json` stdout. Null means "no value to read":
// unparseable, not an array, empty, or field absent. A stored empty string or
// null is a real value and is returned as-is.
export function rowField(stdout, field) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row || typeof row !== "object") return null;
  return field in row ? row[field] : null;
}

// Shell out to the pipeline CLI for one row. Returns null when the CLI is
// missing or fails — callers treat that as "no override", never as an error.
export function queryRow(project, feature, field) {
  const result = pipelineSpawn(["rows", project, "--feature", feature, "--format", "json"]);
  if (result.status !== 0) return null;
  return rowField(result.stdout ?? "", field);
}
