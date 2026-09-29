import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading } from "./fake-io.mjs";

export { fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading };
export const SHIM = fileURLToPath(new URL("../shims/claude-shim.mjs", import.meta.url));
import { join } from "node:path";
import { tmpdir } from "node:os";

// Fixtures shared by the scheduler test files. They live here rather than in
// the topic files because importing a .test.mjs from another .test.mjs
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


// A fake worktree module: records every collect() so a test can assert the
// shared tree is collected once, by the group's last link.
export function fakeWorktree(collectCalls) {
  return {
    prepareIsolation: (t, cfg, resultsDir) => {
      const name = t.worktreeName || t.id;
      return {
        path: join(resultsDir, `wt-${name}`), branch: `swarm/${name}`, name,
        head: "abc123", repo: resultsDir, reused: collectCalls.length > 0,
      };
    },
    collect: (t, cfg, wt) => {
      collectCalls.push({ taskId: t.id, name: wt.name });
      return { kept: true, branch: wt.branch, path: wt.path, diffstat: "1 file changed" };
    },
  };
}

// costWarnTokens is tuned so the cost-warn block — the only place `io.notify`
// fires — trips on "b"'s completion specifically: projectRun refuses to
// project before 2 completions, so "b" is arranged to be the 2nd leaf done.
export function buildStrandPlan(dir) {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const tasks = Object.fromEntries(ids.map((id) => [id, task(id)]));
  const delays = { a: 5, b: 20, c: 300, d: 300, e: 300, f: 300 };
  const usage = { input_tokens: 1000, output_tokens: 0 };
  const spawn = fakeSpawnFactory((call) => {
    const id = promptOf(call).slice(3); // "do x" -> "x"
    return { output: streamOut(`leaf ${id}`, `s-${id}`, usage), delayMs: delays[id] };
  });
  let strandFired = false;
  let sampler = null;
  let postStrandMax = 0;
  const io = makeIo(spawn, {
    notify: () => {
      if (strandFired) return;
      strandFired = true;
      const real = tasks.b.id;
      tasks.b.id = "b-phantom";
      queueMicrotask(() => { tasks.b.id = real; });
      sampler = setInterval(() => { postStrandMax = Math.max(postStrandMax, spawn.gauge.active); }, 3);
    },
  });
  const p = plan(dir, ids.map((id) => tasks[id]));
  return { p, io, stop: () => { if (sampler) clearInterval(sampler); }, postStrandMax: () => postStrandMax };
}


// region-lanes-1's join, reduced: a real git repo so a leaf's branch can
// genuinely carry nothing, and integrate's merge can genuinely be a no-op.
export function gitInRepo(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}

export function initGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "swarm-sched-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo, windowsHide: true });
  return repo;
}

export function commitAllInRepo(cwd, msg) {
  spawnSync("git", ["add", "."], { cwd, windowsHide: true });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", msg], { cwd, windowsHide: true });
}

export function integrateLeaf(id, over) {
  return {
    id, prompt: "p", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Edit,Bash",
    timeoutMs: 5000, after: [], ...over,
  };
}


export function forEachFixLeaf(over = {}) {
  return integrateLeaf("fix", {
    after: ["src"], worktreeName: "fix",
    forEach: { from: "src", path: "files", maxItems: 5 }, prompt: "fix {{item}}",
    ...over,
  });
}


// Hand-built already-expanded shape: an aggregate "fix" over `n` numbered
// clone leaves, each with its own valid (non-bracketed) worktree name.
// timeoutMs is generous (not the 5000 default) because these clones do real
// git worktree creation — spawnSync calls that block the event loop and can
// starve a tight per-task timer under load, a false failure unrelated to the
// code under test.
export function fixCloneTasks(n, over = {}) {
  const clones = Array.from({ length: n }, (_, i) =>
    integrateLeaf(`fix[${i}]`, { worktreeName: `fix-${i}`, timeoutMs: 30000, ...over }));
  const agg = integrateLeaf("fix", {
    after: clones.map((c) => c.id),
    aggregate: { truncated: false, kept: n, total: n },
  });
  return [agg, ...clones];
}

export const streamOut = (text, sid, usage = { input_tokens: 100, output_tokens: 10 }, costUsd, apiKeySource) => [
  ...(sid ? [JSON.stringify({ type: "system", subtype: "init", session_id: sid, ...(apiKeySource && { apiKeySource }) })] : []),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: text, usage,
    ...(costUsd != null && { total_cost_usd: costUsd }),
  }),
].join("\n") + "\n";
