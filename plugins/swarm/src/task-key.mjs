// A run dir is named after the manifest FILE and a result file after the task id,
// so `prior.ok` alone replays a result whose task has since changed — an edited
// prompt or model re-runs nothing, and two manifests sharing a filename (every
// project's generic manifest.json) replay each other's leaves. A result is
// therefore cached only against the hash of the definition that produced it.
import { createHash } from "node:crypto";
import { writeResult, appendRunLog } from "./results.mjs";

// Everything that changes what the leaf does. Deliberately NOT keyed: `id` (it
// already names the file the key lives in), `after`/`when` (graph and gating —
// a re-running dep invalidates through the scheduler's fixed point, and a gate
// change cannot alter the output of a run that already passed it), and
// `timeoutMs`/retries (schedule, not work).
const KEY_FIELDS = [
  "prompt", "model", "provider", "fallbackModel", "fallbackProvider", "effort",
  "allowedTools", "cwd", "outputDir", "workspace", "worktreeName", "branchName",
  "contextWindow", "verifyCitations", "returns", "mustRead", "settings",
  "compute", "depAliases", "integrate", "forEach", "childPlan",
  "manifestItem", "manifestIndex",
];

// Key-order-independent, like manifest.mjs's canonicalize: the same definition
// authored with keys in a different order is the same task.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return v;
}

export function taskKey(task) {
  const def = {};
  for (const k of KEY_FIELDS) if (task?.[k] !== undefined) def[k] = canonical(task[k]);
  return createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 16);
}

// The scheduler's only path for writing a task's own result, so no call site can
// forget the key. Clone definitions differ per item, so a clone's key is its own.
export function writeTaskResult(resultsDir, task, result) {
  return writeResult(resultsDir, task.id, { ...result, key: taskKey(task) });
}

// Reusable only when the recorded key matches. A result carrying NO key predates
// keying — keep it, so an upgrade never re-spends an in-flight run; only a
// recorded MISMATCH is evidence the work changed. The log line is what `status`
// reads to say why a task re-ran.
export function cacheHit(resultsDir, task, prior) {
  if (!prior || prior.ok !== true) return false;
  if (prior.key === undefined || prior.key === taskKey(task)) return true;
  appendRunLog(resultsDir, {
    ts: new Date().toISOString(), id: task.id, event: "cache-miss",
    priorKey: prior.key, reason: "task-definition-changed",
  });
  return false;
}
