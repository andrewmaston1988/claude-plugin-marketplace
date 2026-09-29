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
test("spawn env marks the child as a swarm leaf, whatever the model or provider mode", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
    const io = makeIo(spawn);
    io.env.SWARM_LEAF = "0"; // a caller claiming leaf-ness with the wrong value must lose to the engine
    // One Claude-tier leaf and one :cloud leaf. There is a single spawn site
    // (runTask), so this also covers `launch` mode — buildDispatch varies argv,
    // never the env merge.
    const p = plan(dir, [task("claude-leaf", { provider: "claude", model: "claude-haiku-4-5-20251001", cwd: dir, originalCwd: dir }), task("cloud-leaf", { provider: "ollama", model: "glm-5.3:cloud", cwd: dir, originalCwd: dir })]);
    await runPlan(p, { ...CFG, provider: { ...CFG.provider, allowedRoots: [dir] } }, io);
    equal(spawn.calls.length, 2);
    for (const c of spawn.calls) {
      equal(c.opts.env.SWARM_LEAF, "1", `${c.args.join(" ")} must carry the leaf marker`);
    }
    // The marker is NOT the correlation id: that one yields to a caller's value,
    // this one must always be set or the guard silently stops firing.
    ok(spawn.calls.every((c) => c.opts.env.CORRELATION_ID));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("spawn env carries SWARM_LEAF_GUARD/_PROJECT for a task with a leafGuard", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("guarded", { leafGuard: { name: "myrepo", command: "guard-cmd" } })]);
    await runPlan(p, { ...CFG, provider: { ...CFG.provider, allowedRoots: [dir] } }, io);
    equal(spawn.calls.length, 1);
    equal(spawn.calls[0].opts.env.SWARM_LEAF_GUARD, "guard-cmd");
    equal(spawn.calls[0].opts.env.SWARM_LEAF_GUARD_PROJECT, "myrepo");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the inherited/dispatch env cannot forge or override SWARM_LEAF_GUARD/_PROJECT", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
    const io = makeIo(spawn);
    io.env.SWARM_LEAF_GUARD = "forged";
    io.env.SWARM_LEAF_GUARD_PROJECT = "forged-repo";
    const p = plan(dir, [task("guarded", { leafGuard: { name: "myrepo", command: "guard-cmd" } })]);
    await runPlan(p, { ...CFG, provider: { ...CFG.provider, allowedRoots: [dir] } }, io);
    equal(spawn.calls[0].opts.env.SWARM_LEAF_GUARD, "guard-cmd");
    equal(spawn.calls[0].opts.env.SWARM_LEAF_GUARD_PROJECT, "myrepo");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a task without a leafGuard spawns with neither SWARM_LEAF_GUARD nor _PROJECT set", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: "ok" }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("unguarded")]);
    await runPlan(p, { ...CFG, provider: { ...CFG.provider, allowedRoots: [dir] } }, io);
    equal(spawn.calls[0].opts.env.SWARM_LEAF_GUARD, undefined);
    equal(spawn.calls[0].opts.env.SWARM_LEAF_GUARD_PROJECT, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A leaf's session id is recorded the moment its stream announces it, so a leaf
// whose engine died before it settled (no results/<id>.json) still resumes its
// own session — context intact — instead of restarting cold.
const logLines = (p) => readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const resumeArg = (call) => { const i = call.args.indexOf("--resume"); return i < 0 ? null : call.args[i + 1]; };
const deadEngineLog = (p, entries) => {
  initResultsDir(p.resultsDir);
  writeFileSync(join(p.resultsDir, "run.log"), entries.map((e) => JSON.stringify({ ts: "2026-09-12T08:50:00.000Z", ...e })).join("\n") + "\n");
};

test("session: a leaf's session id lands in run.log before the leaf settles", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("hi", "s-live") }));
    const p = plan(dir, [task("a")]);
    await runPlan(p, CFG, makeIo(spawn));
    const lines = logLines(p);
    const at = lines.findIndex((e) => e.id === "a" && e.event === "session" && e.sessionId === "s-live");
    ok(at >= 0, JSON.stringify(lines));
    ok(at < lines.findIndex((e) => e.id === "a" && e.state === "ok"), "recorded before the settle");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resume: a leaf the dead engine never settled resumes its recorded session", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    deadEngineLog(p, [{ event: "run-start", tasks: [{ id: "a", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, { id: "a", state: "running" }, { id: "a", event: "session", sessionId: "s-dead" }]);
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("back", "s-dead") }));
    await runPlan(p, CFG, makeIo(spawn));
    equal(resumeArg(spawn.calls[0]), "s-dead");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resume: a failed result without a session id falls back to the recorded one", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    deadEngineLog(p, [{ event: "run-start", tasks: [{ id: "a", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, { id: "a", event: "session", sessionId: "s-early" }]);
    writeResult(p.resultsDir, "a", { id: "a", provider: "claude", model: "claude-haiku-4-5-20251001", ok: false, exit: null, output: "spawn died" });
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("back", "s-early") }));
    await runPlan(p, CFG, makeIo(spawn));
    equal(resumeArg(spawn.calls[0]), "s-early");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resume: --force starts fresh even with a recorded session", async () => {
  const dir = tmp();
  try {
    const p = plan(dir, [task("a")]);
    deadEngineLog(p, [{ event: "run-start", tasks: [{ id: "a", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, { id: "a", event: "session", sessionId: "s-dead" }]);
    const spawn = fakeSpawnFactory(() => ({ output: streamOut("fresh", "s-new") }));
    await runPlan(p, CFG, makeIo(spawn), { force: true });
    equal(resumeArg(spawn.calls[0]), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- a writer's cwd depth inside its own tree (what treeCwd is for) ----

test("a writer under <repo>/sub spawns at <tree>/sub, not at the tree root", async () => {
  // RED: bypass treeCwd and hand the leaf wt.path, and every cwd-relative path in its
  // prompt resolves against the wrong directory. This is the #297 defect.
  const repo = initGitRepo();
  const dir = tmp();
  try {
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "x.txt"), "x\n");
    spawnSync("git", ["add", "."], { cwd: repo, windowsHide: true });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
      "commit", "-q", "-m", "sub"], { cwd: repo, windowsHide: true });

    let seen;
    const spawn = fakeSpawnFactory((call) => {
      seen = { cwd: call.opts.cwd, x: existsSync(join(call.opts.cwd, "x.txt")) };
      writeFileSync(join(call.opts.cwd, "out.txt"), "y\n");
      return {};
    });
    const p = plan(repo, [task("a", {
      cwd: join(repo, "sub"), originalCwd: join(repo, "sub"), allowedTools: "Bash",
      worktreeName: "a", checkoutToplevel: repo,
    })], { resultsDir: join(dir, "run"), concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn));
    equal(resolve(seen.cwd), join(p.resultsDir, "wt-a", "sub"));
    equal(seen.x, true, "the leaf sees its own subdirectory's content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a writer whose declared cwd is gitignored still spawns: the tree gets the directory", async () => {
  // RED: drop treeCwd's mkdir and this leaf cannot start — a gitignored directory is not in
  // the tree, so its cwd does not exist there.
  const repo = initGitRepo();
  const dir = tmp();
  try {
    writeFileSync(join(repo, ".gitignore"), ".cache/\n");
    mkdirSync(join(repo, ".cache"));
    let seen;
    const spawn = fakeSpawnFactory((call) => {
      seen = { cwd: call.opts.cwd, there: existsSync(call.opts.cwd) };
      writeFileSync(join(call.opts.cwd, "out.txt"), "y\n");
      return {};
    });
    const p = plan(repo, [task("a", {
      cwd: join(repo, ".cache"), originalCwd: join(repo, ".cache"), allowedTools: "Bash",
      worktreeName: "a", checkoutToplevel: repo,
    })], { resultsDir: join(dir, "run"), concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn));
    equal(resolve(seen.cwd), join(p.resultsDir, "wt-a", ".cache"));
    equal(seen.there, true, "the mapper creates the directory the snapshot never carried");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a writer lands on the run-scoped literal branch, never the unscoped one", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => { writeFileSync(join(call.opts.cwd, "out.txt"), "x\n"); return {}; });
    const p = plan(repo, [
      task("gen", { cwd: repo, originalCwd: repo, allowedTools: "Bash",         worktreeName: "gen", branchScope: "scope1", checkoutToplevel: repo }),
    ], { resultsDir: join(dir, "run"), concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn));
    ok(spawnSync("git", ["branch", "--list", "swarm/scope1/gen"], { cwd: repo, encoding: "utf8" }).stdout.includes("swarm/scope1/gen"));
    equal(spawnSync("git", ["branch", "--list", "swarm/gen"], { cwd: repo, encoding: "utf8" }).stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// A leaf normalizeTasks defaulted to a private tree, as the scheduler sees it.
function privateLeaf(id, repo, over = {}) {
  return task(id, {
    cwd: repo, originalCwd: repo, allowedTools: "Bash",
    worktreeName: id,
    checkoutToplevel: repo, ...over,
  });
}

const writingSpawn = () => fakeSpawnFactory((call) => {
  writeFileSync(join(call.opts.cwd, "out.txt"), "x\n");
  return {};
});

test("a default-private child of a manifest node lands on a branch git accepts", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const childPlan = { tasks: [privateLeaf("impl", repo, { branchScope: "scope1" })] };
    const p = plan(repo, [task("node", { model: "manifest", prompt: "", childPlan, cwd: repo, originalCwd: repo })],
      { resultsDir: join(dir, "run"), concurrency: 1 });
    await runPlan(p, CFG, makeIo(writingSpawn()));

    const res = readResult(p.resultsDir, "node~impl");
    ok(res.ok, res.output);
    const branches = spawnSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" }).stdout;
    ok(branches.includes("swarm/scope1/node-impl"),
      `the remapped name's ~ must be sanitised or worktree add refuses it — got:\n${branches}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("two runs of one manifest in a repo: run-scoped branches keep the second off the first's kept tree", async () => {
  const repo = initGitRepo();
  const dir1 = tmp(), dir2 = tmp();
  try {
    const mk = (resultsDir) => plan(repo, [privateLeaf("gen", repo, { branchScope: oracleSnapKey(resultsDir) })],
      { resultsDir, concurrency: 1 });
    const spawn = fakeSpawnFactory((call) => {
      writeFileSync(join(call.opts.cwd, "untracked.txt"), "x\n");
      return {};
    });
    const r1 = await runPlan(mk(join(dir1, "run")), CFG, makeIo(spawn));
    equal(r1.worktreesKept.length, 1, "an untracked file keeps run one's tree and its branch");

    const p2 = mk(join(dir2, "run"));
    await runPlan(p2, CFG, makeIo(spawn));
    const res = readResult(p2.resultsDir, "gen");
    ok(res.ok, `an unscoped branch would already be checked out in run one's tree — got:\n${res.output}`);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("forEach clones of a default-private writer each get their own run-scoped branch", async () => {
  const repo = initGitRepo();
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => {
      if (promptOf(call) === "do src") return { output: '["a","b"]' };
      writeFileSync(join(call.opts.cwd, "out.txt"), "x\n");
      return {};
    });
    const p = plan(repo, [
      task("src", { cwd: repo, originalCwd: repo }),
      privateLeaf("fix", repo, {
        after: ["src"], branchScope: "scope1", prompt: "fix {{item}}",
        forEach: { from: "src", path: "", maxItems: 2 },
      }),
    ], { resultsDir: join(dir, "run"), concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn));

    const branches = spawnSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" }).stdout;
    for (const b of ["swarm/scope1/fix-0", "swarm/scope1/fix-1"]) {
      ok(branches.includes(b), `one fixed branch for both clones races them — got:\n${branches}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a reader spawns in its own cwd and is never given a tree", async () => {
  const dir = tmp();
  try {
    let spawnCwd;
    const spawn = fakeSpawnFactory((call) => { spawnCwd = call.opts.cwd; return {}; });
    const collectCalls = [];
    const base = fakeWorktree(collectCalls);
    let prepared = 0;
    const worktree = { ...base, prepareIsolation: (...a) => { prepared++; return base.prepareIsolation(...a); } };
    const p = plan(dir, [task("ro", { allowedTools: "Read,Grep", cwd: dir, originalCwd: dir })]);
    await runPlan(p, CFG, makeIo(spawn, { worktree }));

    equal(spawnCwd, dir, "a reader runs in the cwd it was approved for");
    equal(prepared, 0, "a reader that resolves to a worktree name silently gets a tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
