import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { runPlan, runTask, substituteTemplates, substituteItems, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { CFG, tmp, task, plan, fakeSpawnFactory, makeIo, promptOf, gitInRepo, initGitRepo, commitAllInRepo, buildStrandPlan, integrateLeaf } from "./helpers/scheduler-fixtures.mjs";
import { CFG as MANIFEST_CFG, writeManifest } from "./helpers/manifest-fixtures.mjs";
// S1/S3 pin the `running` map slot leak: a leaf whose IIFE resolves a value other than
// the id it launched under, which `running.delete(finished)` cannot handle. Seam —
// `io.notify` fires inside the launch IIFE (after `record()`, before `return task.id`),
// so the hook corrupts `task.id` for one read and reverts it via queueMicrotask, queued
// ahead of `.finally()`. costWarnTokens trips that block on "b", the 2nd leaf done.

test("S1: a stranded slot must not permanently narrow the run", { timeout: 5000 }, async () => {
  const dir = tmp();
  try {
    const { p, io, stop, postStrandMax } = buildStrandPlan(dir);
    const r = await runPlan(p, { ...CFG, costWarnTokens: 5000 }, io);
    stop();
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    for (const id of ["a", "b", "c", "d", "e", "f"]) ok(states[id], `task ${id} never reached a terminal state`);
    equal(postStrandMax(), 4, `peak concurrency after the strand was ${postStrandMax()}, want 4`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: an ordinary healthy run emits no slot-leak events", async () => {
  const dir = tmp();
  try {
    let flakyCalls = 0;
    const spawn = fakeSpawnFactory((call) => {
      const p = promptOf(call);
      if (p === "do flaky") { flakyCalls++; return flakyCalls < 2 ? { exit: 1, output: "429 rate limit" } : { output: "recovered" }; }
      if (p === "do src") return { output: '{"sites":[1]}' };
      return { output: "ok" };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("a"), task("b"), task("flaky"),
      task("src"),
      task("gate", { after: ["src"], when: { from: "src", expr: "length(value.sites) > 2" } }),
      task("child", { after: ["gate", "flaky"] }),
    ], { concurrency: 4 });
    const r = await runPlan(p, { ...CFG, retry: { rateLimited: 2, backoffMs: 10 } }, io);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.gate, "skipped");
    equal(states.flaky, "ok");
    equal(states.child, "ok");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    equal(logLines.filter((l) => l.event === "slot-leak").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// S3 (instrument names the stranded ids) was verified RED against the buildStrandPlan
// repro before the .finally() fix landed: run.log showed
// {"event":"slot-leak","held":4,"live":3,"stranded":["b"]}. Not pinned as a standing test —
// the fix closes this exact leak class (see S1), so no repro can make it fire post-fix
// without reintroducing the bug it guards against.
test("S4: a parked retry frees its slot for another pending task", async () => {
  const dir = tmp();
  try {
    let flakyCalls = 0;
    const spawn = fakeSpawnFactory((call) => {
      const p = promptOf(call);
      if (p === "do flaky") { flakyCalls++; return flakyCalls < 2 ? { exit: 1, output: "429 rate limit" } : { output: "recovered" }; }
      return { output: "b done" };
    });
    const io = makeIo(spawn);
    const p = plan(dir, [task("flaky"), task("b")], { concurrency: 1 });
    const r = await runPlan(p, { ...CFG, retry: { rateLimited: 2, backoffMs: 30 } }, io);
    const order = spawn.calls.map(promptOf);
    deepEqual(order, ["do flaky", "do b", "do flaky"]); // b launches while flaky is parked
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.flaky, "ok");
    equal(states.b, "ok");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    equal(logLines.filter((l) => l.event === "slot-leak").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5: a when-skipped task occupies no concurrency slot", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: '{"sites":[1]}', delayMs: 15 }));
    const io = makeIo(spawn);
    const p = plan(dir, [
      task("src"),
      task("gate", { after: ["src"], when: { from: "src", expr: "length(value.sites) > 2" } }),
      task("x"), task("y"),
    ], { concurrency: 2 });
    const r = await runPlan(p, CFG, io);
    ok(spawn.gauge.max >= 2, `peak width was ${spawn.gauge.max}, want >= 2 despite the gated skip`);
    const states = Object.fromEntries(r.summary.tasks.map((t) => [t.id, t.state]));
    equal(states.gate, "skipped");
    equal(states.x, "ok");
    equal(states.y, "ok");
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    equal(logLines.filter((l) => l.event === "slot-leak").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6: concurrency width recovers to the ceiling across waves", async () => {
  const dir = tmp();
  try {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const spawn = fakeSpawnFactory(() => ({ delayMs: 15 }));
    const io = makeIo(spawn);
    const p = plan(dir, ids.map((id) => task(id)), { concurrency: 4 });
    // Split samples by the 5th spawn call (the first admission of the second
    // wave) rather than a wall-clock threshold — process/test-harness
    // start-up jitter makes an absolute time cutoff unreliable.
    const samples1 = [];
    const samples2 = [];
    let wave2 = false;
    const sampler = setInterval(() => {
      if (!wave2 && spawn.calls.length >= 5) wave2 = true;
      (wave2 ? samples2 : samples1).push(spawn.gauge.active);
    }, 2);
    await runPlan(p, CFG, io);
    clearInterval(sampler);
    equal(spawn.calls.length, 8);
    equal(Math.max(0, ...samples1), 4, "first wave never reached the ceiling");
    equal(Math.max(0, ...samples2), 4, "second wave never reached the ceiling — width ratcheted down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// region-lanes-1's join, reduced: a real git repo so a leaf's branch can
// genuinely carry nothing, and integrate's merge can genuinely be a no-op.

test("IS1: integrate over a committed leaf and a no-change leaf completes", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
      } else if (cwd.endsWith("wt-committer")) {
        writeFileSync(join(cwd, "committer.txt"), "committer work\n");
        commitAllInRepo(cwd, "committer work");
      }
      // wt-nochange: touch nothing — a leaf that legitimately changed nothing.
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat" }),
        integrateLeaf("committer", { cwd: repo, originalCwd: repo, after: ["helper"], worktreeName: "committer" }),
        integrateLeaf("nochange", { cwd: repo, originalCwd: repo, after: ["helper"], worktreeName: "nochange" }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["committer", "nochange"], worktreeName: "feat",
          integrate: { into: "feat", from: ["committer", "nochange"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, true, "the integrate completes despite one source changing nothing");
    deepEqual(res.outputJson.merged, ["swarm/committer", "swarm/nochange"]);
    ok(existsSync(join(p.resultsDir, "wt-feat", "committer.txt")),
      "the committing leaf's change lands in the target tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("IS2: a no-change leaf that no integrate names is still swept", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
      } else if (cwd.endsWith("wt-committer")) {
        writeFileSync(join(cwd, "committer.txt"), "committer work\n");
        commitAllInRepo(cwd, "committer work");
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat" }),
        integrateLeaf("committer", { cwd: repo, originalCwd: repo, after: ["helper"], worktreeName: "committer" }),
        integrateLeaf("nochange", { cwd: repo, originalCwd: repo, after: ["helper"], worktreeName: "nochange" }),
        // Only "committer" is named — "nochange" is not a source of anything.
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["committer", "nochange"], worktreeName: "feat",
          integrate: { into: "feat", from: ["committer"] } },
      ],
    };
    await runPlan(p, CFG, io);

    equal(gitInRepo(["branch", "--list", "swarm/nochange"], repo), "",
      "a no-change leaf that no integrate names must still be reaped, branch and all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("IS3: integrate's missing-ref throw still fires for a ref absent for a reason other than the sweep", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat" }),
        // "ghost" names no task in this plan, so its branch was never created —
        // a ref missing for a reason the sweep did not cause, which the throw
        // at worktree.mjs's integrate() must still catch.
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["helper"], worktreeName: "feat",
          integrate: { into: "feat", from: ["ghost"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    equal(res.ok, false, "a ref missing for an unrelated reason must still fail the node");
    ok(/cannot merge/.test(res.output), `expected the original throw message, got: ${res.output}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// The documented mixed topology: an agentless seed integrate node creates a writer's
// tree BEFORE the writer runs, so the writer reuses that tree under a different branch
// name. The join must merge the ref the seed created — where the writer's commits landed.
test("IS4: a seed integrate node's tree, reused by a workspace writer, joins on the branch the seed created", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      const cwd = call.opts.cwd;
      if (cwd.endsWith("wt-feat")) {
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAllInRepo(cwd, "base");
      } else if (cwd.endsWith("wt-migrate-x")) {
        writeFileSync(join(cwd, "migrated.txt"), "migrated\n");
        commitAllInRepo(cwd, "migrate");
      }
      return { output: "done" };
    });
    const io = makeIo(spawn);
    const p = {
      cwd: repo, resultsDir: join(dir, "run"), concurrency: 1, goal: "",
      tasks: [
        // branchScope is what manifest.mjs gives a writer inside a git repo — and,
        // with the seed below, an integrate node too. One run, one resultsDir, one
        // scope: the seed and the writer that reuses its tree resolve the SAME ref.
        integrateLeaf("helper", { cwd: repo, originalCwd: repo, worktreeName: "feat", branchScope: "run1" }),
        { id: "seed-x", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["helper"], worktreeName: "migrate-x", branchScope: "run1",
          integrate: { into: "migrate-x", from: ["helper"] } },
        integrateLeaf("migrate-x", { cwd: repo, originalCwd: repo, after: ["seed-x"],
          worktreeName: "migrate-x", branchScope: "run1" }),
        { id: "join", model: "integrate", prompt: "", allowedTools: "", cwd: repo, originalCwd: repo,
          timeoutMs: 5000, after: ["migrate-x"], worktreeName: "feat",
          integrate: { into: "feat", from: ["migrate-x"] } },
      ],
    };
    await runPlan(p, CFG, io);

    const res = JSON.parse(readFileSync(join(p.resultsDir, "results", "join.json"), "utf8"));
    ok(gitInRepo(["branch", "--list", "swarm/run1/migrate-x"], repo) !== "",
      "precondition: the seed created swarm/run1/migrate-x — the ref the writer reused and committed onto");
    equal(res.ok, true, `the join must merge the branch its source actually created, got: ${res.output}`);
    deepEqual(res.outputJson.merged, ["swarm/run1/migrate-x"],
      "the writer's commits are on the seed's branch, so that is the ref the join merges");
    ok(existsSync(join(p.resultsDir, "wt-feat", "migrated.txt")),
      "the writer's commit reaches the target tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// An integrate node's tree survives its run. Two runs of one manifest in one repo
// therefore land on each other's `into` branch — unless normalisation scopes that
// branch to the running run. This drives the REAL normalisation (loadManifest, as
// `swarm run` does), so the scope is derived from each run's resultsDir, never
// hand-set: a hand-built plan would be given the scope by the test and prove nothing.
test("IS5: two runs of one manifest seeding the same `into` do not collide on the branch", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const body = (resultsDir) => ({ resultsDir, tasks: [
      { id: "src", prompt: "do src", provider: "claude", model: "claude-haiku-4-5-20251001",
        allowedTools: "Read,Edit,Bash", cwd: repo },
      { id: "seed", after: ["src"], integrate: { into: "feat", from: ["src"] } },
    ] });
    const runOnce = async (name) => {
      const p = loadManifest(writeManifest(dir, body(join(dir, name)), `${name}.json`), MANIFEST_CFG, repo);
      return runPlan(p, CFG, makeIo(fakeSpawnFactory(() => ({}))));
    };

    await runOnce("run-a");
    const b = await runOnce("run-b");

    const seedB = b.summary.tasks.find((t) => t.id === "seed");
    equal(seedB.state, "ok",
      `the second run's integrate node must re-enter its OWN branch, not the first run's kept tree: ${JSON.stringify(seedB)}`);
    const branchOf = (name) => JSON.parse(readFileSync(join(dir, name, "results", "seed.json"), "utf8")).outputJson.branch;
    ok(branchOf("run-a") !== branchOf("run-b"),
      `each run's seed owns its own branch: ${branchOf("run-a")} vs ${branchOf("run-b")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
