import { test } from "node:test";
import { equal, deepEqual, ok, rejects, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { runPlan, runTask, substituteTemplates, substituteItems, classifyFailure, pickNewestRunning } from "../src/scheduler.mjs";
import { writeResult, readResult, initResultsDir, resultPath, writeDigestMd, writeSummary, readHeartbeat, stopPath } from "../src/results.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf, fakeSpawnFactory, makeIo, promptOf, sentPrompt, usageEnv, codexReading, SHIM, streamOut, gitInRepo, initGitRepo, commitAllInRepo, fakeWorktree, buildStrandPlan, integrateLeaf, forEachFixLeaf, fixCloneTasks } from "./helpers/scheduler-fixtures.mjs";
test("collect runs once, after the last task in a shared worktree group", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const p = plan(dir, [
      task("p1", { worktreeName: "feat" }),
      task("rev", { after: ["p1"], worktreeName: "feat" }),
      task("p2", { after: ["rev"], worktreeName: "feat" }),
    ]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })),
      { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);

    equal(collectCalls.length, 1, `collect must run once per group, got ${JSON.stringify(collectCalls)}`);
    equal(collectCalls[0].taskId, "p2", "collect runs after the LAST group member");
    equal(r.worktreesKept.length, 1, "one entry per group, not per task");
    equal(r.worktreesKept[0].name, "feat");
    deepEqual(r.worktreesKept[0].taskIds, ["p1", "rev", "p2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-chain link reports its tree as pending rather than collected", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const p = plan(dir, [
      task("p1", { worktreeName: "feat" }),
      task("p2", { after: ["p1"], worktreeName: "feat" }),
    ]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })),
      { worktree: fakeWorktree(collectCalls) });
    await runPlan(p, CFG, io);

    const first = readResult(p.resultsDir, "p1");
    equal(first.worktree.pending, true, "a mid-chain link must not claim its tree was collected");
    equal(first.worktree.branch, "swarm/feat");
    const last = readResult(p.resultsDir, "p2");
    equal(last.worktree.pending, undefined);
    equal(last.worktree.kept, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a private worktree still collects per task", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const p = plan(dir, [
      task("a", { worktreeName: "a" }),
      task("b", { worktreeName: "b" }),
    ]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })),
      { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);
    equal(collectCalls.length, 2, "each private tree is its own group of one");
    equal(r.worktreesKept.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach clones each get their own private worktree, never the parent's", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do src") return { output: '{"sites":[{"f":"a"},{"f":"b"}]}' };
      return { output: "done" };
    });
    const p = plan(dir, [
      task("src"),
      task("fix", {
        after: ["src"], worktreeName: "fix",
        forEach: { from: "src", path: "sites", maxItems: 5 }, prompt: "fix {{item.f}}",
      }),
    ]);
    const io = makeIo(spawn, { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);

    const names = collectCalls.map((c) => c.name).sort();
    deepEqual(names, ["fix-0", "fix-1"],
      "each clone needs its own tree — sharing the parent's name races them in one directory");
    equal(r.worktreesKept.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest children with their own trees are collected under remapped names", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const childPlan = {
      tasks: [
        task("impl", { worktreeName: "impl", after: [] }),
        task("check", { after: ["impl"], worktreeName: "impl2" }),
      ],
    };
    const p = plan(dir, [task("node", { model: "manifest", prompt: "", childPlan })]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })),
      { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);

    const names = collectCalls.map((c) => c.name).sort();
    deepEqual(names, ["node~impl", "node~impl2"],
      "a spliced child's worktree name must be remapped, or two nodes' children collide on one path");
    equal(r.worktreesKept.length, 2, "spliced children must still be collected, not orphaned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child's worktree name cannot collide with the parent's or a sibling node's", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const mkChild = () => ({
      tasks: [task("impl", { worktreeName: "feat", after: [] })],
    });
    const p = plan(dir, [
      task("feat", { worktreeName: "feat" }),
      task("nodeA", { model: "manifest", prompt: "", childPlan: mkChild() }),
      task("nodeB", { model: "manifest", prompt: "", childPlan: mkChild() }),
    ]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })),
      { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);

    const names = r.worktreesKept.map((w) => w.name).sort();
    deepEqual(names, ["feat", "nodeA~feat", "nodeB~feat"],
      "three distinct trees — an un-remapped child name would put all three on one path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forEach'd manifest node gives each clone's children their own worktrees", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const spawn = fakeSpawnFactory((call) => {
      const pr = promptOf(call);
      if (pr === "do src") return { output: '{"sites":["a","b"]}' };
      return { ok: true, output: "done" };
    });
    const childPlan = {
      tasks: [task("impl", { worktreeName: "feat", after: [] })],
    };
    const p = plan(dir, [
      task("src"),
      task("audit", {
        model: "manifest", prompt: "", childPlan, after: ["src"],
        forEach: { from: "src", path: "sites", maxItems: 5 },
      }),
    ]);
    const io = makeIo(spawn, { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);

    const names = r.worktreesKept.map((w) => w.name).sort();
    deepEqual(names, ["audit[0]~feat", "audit[1]~feat"],
      "clones splice identical children — without per-clone remapping they'd share one tree concurrently");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed final link must not destroy its predecessors' committed work", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "do p2" ? { ok: false, exit: 1, output: "boom" } : { ok: true, output: "done" });
    const p = plan(dir, [
      task("p1", { worktreeName: "feat" }),
      task("p2", { after: ["p1"], worktreeName: "feat" }),
    ]);
    const io = makeIo(spawn, { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);

    equal(r.summary.tasks.find((t) => t.id === "p2").state, "failed");
    // The tree is still collected — a failed leaf's partial work is salvageable —
    // but it must be KEPT, never destroyed: the branch carries p1's commits.
    deepEqual(r.worktreesKept.map((w) => w.name), ["feat"],
      "the shared branch must survive a failed final link, with p1's work on it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand-built writer with no worktreeName still gets a tree", async () => {
  const dir = tmp();
  const collectCalls = [];
  try {
    const p = plan(dir, [task("a", { allowedTools: "Bash", cwd: dir, checkoutToplevel: dir })]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })),
      { worktree: fakeWorktree(collectCalls) });
    const r = await runPlan(p, CFG, io);
    deepEqual(collectCalls.map((c) => c.name), ["a"],
      "runPlan accepts hand-built plans — the write tools must resolve to a tree without normalizeTasks");
    equal(r.worktreesKept.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a destroyed (unchanged) tree is absent from worktreesKept", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [
      task("a", { worktreeName: "a" }),
      task("b", { worktreeName: "b" }),
    ]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })), {
      worktree: {
        prepareIsolation: (t, cfg, resultsDir) => ({
          path: join(resultsDir, `wt-${t.worktreeName}`), branch: `swarm/${t.worktreeName}`,
          name: t.worktreeName, head: "h", repo: resultsDir, reused: false,
        }),
        // 'b' changed nothing, so its tree and branch were deleted
        collect: (t, cfg, wt) => t.id === "b"
          ? { kept: false, branch: wt.branch, path: wt.path }
          : { kept: true, branch: wt.branch, path: wt.path, diffstat: "1 file changed" },
      },
    });
    const r = await runPlan(p, CFG, io);
    deepEqual(r.worktreesKept.map((w) => w.name), ["a"],
      "a deleted tree reported as kept sends the session to a path that no longer exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--force resets only the first link of a shared worktree group", async () => {
  const dir = tmp();
  const resets = [];
  try {
    const p = plan(dir, [
      task("p1", { worktreeName: "feat" }),
      task("p2", { after: ["p1"], worktreeName: "feat" }),
    ]);
    const io = makeIo(fakeSpawnFactory(() => ({ ok: true, output: "done" })), {
      worktree: {
        prepareIsolation: (t, cfg, resultsDir, opts) => {
          resets.push({ id: t.id, reset: opts.reset });
          return { path: join(resultsDir, "wt-feat"), branch: "swarm/feat", name: "feat", head: "h", repo: resultsDir, reused: false };
        },
        collect: (t, cfg, wt) => ({ kept: true, branch: wt.branch, path: wt.path, diffstat: "d" }),
      },
    });
    await runPlan(p, CFG, io, { force: true });
    deepEqual(resets, [{ id: "p1", reset: true }, { id: "p2", reset: false }],
      "a later link must never scrub its predecessor's commits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every leaf is spawned with CORRELATION_ID so session hooks stay out of it", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "results"), { recursive: true });
    const leafLog = createWriteStream(join(dir, "results", "a.log"));
    const spawn = fakeSpawnFactory(() => ({ output: "x" }));
    const io = makeIo(spawn, { env: { PATH: process.env.PATH } });

    await runTask(task("a"), "do a", CFG, io, leafLog, {});

    equal(spawn.calls[0].opts.env.CORRELATION_ID, "swarm:a",
      "a headless leaf must carry the marker the checkpoint hooks exit on");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a caller's own CORRELATION_ID is kept on the leaf", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "results"), { recursive: true });
    const leafLog = createWriteStream(join(dir, "results", "a.log"));
    const spawn = fakeSpawnFactory(() => ({ output: "x" }));
    const io = makeIo(spawn, { env: { PATH: process.env.PATH, CORRELATION_ID: "pipeline-77" } });

    await runTask(task("a"), "do a", CFG, io, leafLog, {});

    equal(spawn.calls[0].opts.env.CORRELATION_ID, "pipeline-77");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Red input for the real-model stamp: the CLI's stream-json init event names
// the model that actually ran (claude-sonnet-5-20260101), while task.model is the
// family id (claude-sonnet-5). Without the stamp the result records only the alias and
// every generation (opus 4.8 vs 5) collapses into one perf row.
test("result stamps the init event's real model id; alias kept as modelAlias", async () => {
  const dir = tmp();
  try {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", provider: "claude", model: "claude-sonnet-5-20260101", session_id: "s1" }),
      JSON.stringify({ type: "result", subtype: "success", result: "hi", session_id: "s1" }),
      "",
    ].join("\n");
    const spawn = fakeSpawnFactory(() => ({ output: stream }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { provider: "claude", model: "claude-sonnet-5" })]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "a");
    equal(res.model, "claude-sonnet-5-20260101");
    equal(res.modelAlias, "claude-sonnet-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Control: a non-Claude leaf keeps its manifest model verbatim — the :cloud
// suffix is a routing/governance identity, so an init-reported bare name must
// never overwrite it.
test("non-Claude leaf keeps its manifest model; no modelAlias", async () => {
  const dir = tmp();
  try {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", model: "glm-5.2", session_id: "s2" }),
      JSON.stringify({ type: "result", subtype: "success", result: "hi", session_id: "s2" }),
      "",
    ].join("\n");
    const spawn = fakeSpawnFactory(() => ({ output: stream }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", { provider: "ollama", model: "glm-5.2:cloud", cwd: tmpdir(), originalCwd: tmpdir() })]);
    await runPlan(p, { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } }, io);
    const res = readResult(p.resultsDir, "a");
    equal(res.model, "glm-5.2:cloud");
    equal(res.modelAlias, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
