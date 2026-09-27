import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Fixtures shared by the scheduler test files. They live here rather than in
// scheduler.test.mjs because importing a .test.mjs from another .test.mjs
// re-registers and re-runs its rows in the importing file process.
export const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

export function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-sched-"));
}

export function task(id, over = {}) {
  return {
    id,
    prompt: `do ${id}`,
    provider: "claude", model: "claude-haiku-4-5-20251001",
    allowedTools: "Read,Grep,Glob",
    cwd: over.cwd || tmpdir(),
    originalCwd: over.cwd || tmpdir(),
    timeoutMs: 5000,
    after: [],
    ...over,
  };
}

export function plan(dir, tasks, over = {}) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "", ...over };
}

export function computeTask(id, expr, after) {
  return task(id, { compute: expr, model: "compute", prompt: "", allowedTools: "", after });
}

export const childPlanOf = (...tasks) => ({ tasks });
