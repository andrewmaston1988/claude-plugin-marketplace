import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { runPlan, runTask, substituteTemplates, substituteItems, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { CFG, tmp, fakeSpawnFactory, makeIo, promptOf, initGitRepo, commitAllInRepo, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
// ── F3-F7: integrate.from over a forEach parent ──────────────────────────────
// The parent has no branch of its own — its clones do. These hand-build the POST-expansion
// shape, pinning the seam where `expandForEach` mints the tree as `${parentId}-${i}` (a
// bracket is not a valid git ref char) while the id keeps its brackets, as CLONE_RE and
// resolveIntegrateFrom expect. F9 drives the real expansion end to end.

test("F3: integrate.from over a forEach parent merges exactly the clones that expanded, in index order", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      const m = /wt-fix-(\d+)$/.exec(cwd);
      if (m) {
        writeFileSync(join(cwd, `fix${m[1]}.txt`), `fix ${m[1]}\n`);
        commitAllInRepo(cwd, `fix ${m[1]}`);
        return { output: `done-${m[1]}` };
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", timeoutMs: 30000 }),
        ...fixCloneTasks(2, { cwd: repo, originalCwd: repo }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 30000, after: ["helper", "fix"], worktreeName: "feat",
          integrate: { into: "feat", from: ["fix"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, res.output);
    deepEqual(res.outputJson.merged, ["swarm/fix-0", "swarm/fix-1"]);
    ok(existsSync(join(p.resultsDir, "wt-feat", "fix0.txt")));
    ok(existsSync(join(p.resultsDir, "wt-feat", "fix1.txt")));
    // This plan is hand-built: its tasks carry no normalisation fields, so the run
    // must find each task's repo from the task's OWN cwd. A capture keyed off a
    // normalisation field would pin nothing here, and every launch would have no
    // base to cut from.
    const bases = JSON.parse(readFileSync(join(p.resultsDir, "bases.json"), "utf8"));
    equal(Object.values(bases).length, 1, `the hand-built plan's one repo is pinned: ${JSON.stringify(bases)}`);
    ok(/^[0-9a-f]{40}$/.test(Object.values(bases)[0]), `a real commit is pinned: ${JSON.stringify(bases)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("F4: integrate waits for every clone, and a no-change clone's branch survives collect() until the merge", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      // fix-0 commits; fix-1 legitimately changes nothing.
      if (cwd.endsWith("wt-fix-0")) {
        writeFileSync(join(cwd, "fix0.txt"), "fix 0\n");
        commitAllInRepo(cwd, "fix 0");
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", timeoutMs: 30000 }),
        ...fixCloneTasks(2, { cwd: repo, originalCwd: repo }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 30000, after: ["helper", "fix"], worktreeName: "feat",
          integrate: { into: "feat", from: ["fix"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, res.output);
    deepEqual(res.outputJson.merged, ["swarm/fix-0", "swarm/fix-1"],
      "the no-change clone's branch must still be named — the merge needs the ref, not its contents");
    ok(existsSync(join(p.resultsDir, "wt-feat", "fix0.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("F5: two clones editing the same line — conflict markers, conflicts list, node stays ok", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "shared.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      const m = /wt-fix-(\d+)$/.exec(cwd);
      if (m) {
        writeFileSync(join(cwd, "shared.txt"), `clone ${m[1]} wins\n`);
        commitAllInRepo(cwd, `clone ${m[1]}`);
        return { output: `done-${m[1]}` };
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", timeoutMs: 30000 }),
        ...fixCloneTasks(2, { cwd: repo, originalCwd: repo }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 30000, after: ["helper", "fix"], worktreeName: "feat",
          integrate: { into: "feat", from: ["fix"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, "a content conflict is not a node failure — same as an ordinary integrate");
    deepEqual(res.outputJson.conflicts, ["shared.txt"]);
    const merged = readFileSync(join(p.resultsDir, "wt-feat", "shared.txt"), "utf8");
    ok(merged.includes("<<<<<<<"), "conflict markers are left in the tree for the next leaf to resolve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("F6: an empty forEach source merges nothing, completes ok, dependents run", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      const pr = promptOf(call);
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      if (pr === "do src") return { output: '{"files":[]}' };
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat" }),
        integrateLeaf("src", { cwd: repo, originalCwd: repo, prompt: "do src" }),
        forEachFixLeaf({ cwd: repo, originalCwd: repo }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["helper", "fix"], worktreeName: "feat",
          integrate: { into: "feat", from: ["fix"] } },
        integrateLeaf("sink", { cwd: repo, originalCwd: repo, after: ["join"] }),
      ],
    };
    const r = await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, res.output);
    deepEqual(res.outputJson.merged, []);
    equal(r.summary.tasks.find((t) => t.id === "sink").state, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("F7: a failed clone blocks integrate exactly as a failed hand-listed source does today", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      if (cwd.endsWith("wt-fix-1")) return { exit: 1, output: "boom" };
      const m = /wt-fix-(\d+)$/.exec(cwd);
      if (m) {
        writeFileSync(join(cwd, `fix${m[1]}.txt`), `fix ${m[1]}\n`);
        commitAllInRepo(cwd, `fix ${m[1]}`);
        return { output: `done-${m[1]}` };
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", timeoutMs: 30000 }),
        ...fixCloneTasks(2, { cwd: repo, originalCwd: repo }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 30000, after: ["helper", "fix"], worktreeName: "feat",
          integrate: { into: "feat", from: ["fix"] } },
      ],
    };
    const r = await runPlan(p, CFG, io);

    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states["fix[1]"], "failed");
    equal(states.join, "blocked", "a failed clone's branch is exactly as unusable as any other failed source");
    ok(!existsSync(join(p.resultsDir, "results", "join.json")), "a blocked node never runs, never writes a result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// F9: drives a REAL forEach template (not fixCloneTasks' hand-built shape)
// through actual expansion, so a real 3-item source mints 3 real clones and
// prepareIsolation runs for real on each — this is what the bracketed
// worktree name broke (see the F3-F7 header comment above).
test("F9: a real forEach template with a worktree name actually expands and folds back through integrate", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      const pr = promptOf(call);
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
        return { output: "done" };
      }
      if (pr === "do src") return { output: '{"files":["a","b","c"]}' };
      const m = /wt-fix-(\d+)$/.exec(cwd);
      if (m) {
        writeFileSync(join(cwd, `fix${m[1]}.txt`), `fix ${m[1]}\n`);
        commitAllInRepo(cwd, `fix ${m[1]}`);
        return { output: `done-${m[1]}` };
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 4, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", timeoutMs: 30000 }),
        integrateLeaf("src", { cwd: repo, originalCwd: repo, prompt: "do src" }),
        forEachFixLeaf({ cwd: repo, originalCwd: repo, timeoutMs: 30000 }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 30000, after: ["helper", "fix"], worktreeName: "feat",
          integrate: { into: "feat", from: ["fix"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, res.output);
    equal(res.outputJson.merged.length, 3, "a real 3-item forEach must expand to 3 clones and fold every one back");
    ok(existsSync(join(p.resultsDir, "wt-feat", "fix0.txt")));
    ok(existsSync(join(p.resultsDir, "wt-feat", "fix1.txt")));
    ok(existsSync(join(p.resultsDir, "wt-feat", "fix2.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
