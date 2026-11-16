// What a resume would re-run, so validate can say it before `run` adopts a
// results dir. Deliberately never calls cacheHit: that appends a cache-miss line
// to run.log, and validate describes a run — it must not write into one.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readResult, resultPath } from "./results.mjs";
import { runLiveness } from "./runlog.mjs";
import { taskKey } from "./task-key.mjs";

// A result file that exists but does not parse (a live engine mid-write) is not
// a missing one — "new" would understate what resume does.
const UNREADABLE = { unreadable: true };

function readPreviewResult(dir, id) {
  const prior = readResult(dir, id);
  if (prior) return prior;
  return existsSync(resultPath(dir, id)) ? UNREADABLE : null;
}

// An initialised run dir with no results yet is a run that never finished a leaf,
// not an earlier run to warn about.
function holdsResults(dir) {
  try {
    return readdirSync(join(dir, "results")).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

// Why this task runs again, or null when its stored result is reusable — the
// same predicate cacheHit applies, read-only.
function rerunReason(prior, task) {
  if (!prior) return "new";
  if (prior.unreadable) return "unreadable";
  if (prior.ok !== true) return "previous run failed";
  if (prior.key === undefined || prior.key === taskKey(task)) return null;
  return "definition changed";
}

export function resumePreview(plan, { readResult: read = readPreviewResult, liveness = runLiveness } = {}) {
  const dir = plan.resultsDir;
  if (!dir || !holdsResults(dir)) return [];
  const tasks = plan.tasks || [];
  // id -> why it re-executes, or null when reused. A reused task is invalidated
  // by a re-executing dependency, transitively — the scheduler's own fixed point.
  const reason = new Map(tasks.map((t) => [t.id, rerunReason(read(dir, t.id), t)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tasks) {
      if (reason.get(t.id)) continue;
      const dep = (t.after || []).find((d) => reason.get(d));
      if (dep === undefined) continue;
      reason.set(t.id, `depends on ${dep}`);
      changed = true;
    }
  }
  const rerun = tasks.filter((t) => reason.get(t.id));
  if (!rerun.length) return [];
  const state = liveness(dir);
  const live = state.finishedMs == null && state.stoppedMs == null && state.abortedMs == null;
  const listed = rerun.map((t) => `${t.id} (${reason.get(t.id)})`).join(", ");
  // Clones and child leaves exist only after expansion, so their own keys are
  // unknowable here — name the parent and say when they get checked.
  const expanded = rerun.flatMap((t) => [
    ...(t.forEach ? [`clones of ${t.id}`] : []),
    ...(t.childPlan ? [`child leaves of ${t.id}`] : []),
  ]);
  const tail = expanded.length ? ` — ${expanded.join(" and ")} are checked when they expand` : "";
  return [`results dir ${dir} holds an earlier run (${live ? "live engine" : "finished"}); on resume these re-execute: ${listed}${tail}`];
}
