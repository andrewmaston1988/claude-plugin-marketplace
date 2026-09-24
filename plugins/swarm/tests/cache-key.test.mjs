// A re-run replays a cached leaf only when the task that produced it is unchanged.
// Every row drives a real runPlan twice against ONE resultsDir with the manifest
// reloaded in between, so the assertion is on the DISPATCH, never on the key helper.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./helpers/repo-io.mjs";
import { readResult, resultPath } from "../src/results.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cache-key-"));
}

function gitInit(dir) {
  if (existsSync(join(dir, ".git"))) return;
  const g = (a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, windowsHide: true });
  g(["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g(["add", "seed.txt"]);
  g(["commit", "-q", "-m", "init"]);
}

// Same manifest path and same resultsDir on every call: the second run resumes
// into the first run's dir, which is exactly the re-run being tested.
function loadPlan(dir, body) {
  gitInit(dir);
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ resultsDir: join(dir, "run"), ...body }));
  return loadManifest(p, CFG, dir);
}

const one = (prompt, over = {}) => ({
  tasks: [{ id: "a", prompt, provider: "claude", model: "claude-haiku-4-5-20251001", ...over }],
});

function logOf(plan) {
  return readFileSync(join(plan.resultsDir, "run.log"), "utf8");
}

test("resume: a task whose prompt changed re-runs instead of replaying the cached result", async () => {
  const dir = tmp();
  try {
    await runPlan(loadPlan(dir, one("say ONE")), CFG, makeIo(fakeSpawnFactory(() => ({ output: "one" }))));
    const second = loadPlan(dir, one("say TWO"));
    const spawn = fakeSpawnFactory(() => ({ output: "two" }));
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 1, "a changed prompt must dispatch a leaf, not replay the cached result");
    equal(readResult(second.resultsDir, "a").prompt, "say TWO");
    ok(logOf(second).includes('"event":"cache-miss"'), "the run log must say why the task re-ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a task whose model changed re-runs", async () => {
  const dir = tmp();
  try {
    await runPlan(loadPlan(dir, one("inspect")), CFG, makeIo(fakeSpawnFactory(() => ({ output: "one" }))));
    const second = loadPlan(dir, one("inspect", { model: "claude-sonnet-5" }));
    const spawn = fakeSpawnFactory(() => ({ output: "two" }));
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 1, "a changed model must dispatch a leaf, not replay the cached result");
    equal(readResult(second.resultsDir, "a").model, "claude-sonnet-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: an unchanged task still skips, and its result records the key it was cached against", async () => {
  const dir = tmp();
  try {
    const first = loadPlan(dir, one("inspect"));
    await runPlan(first, CFG, makeIo(fakeSpawnFactory(() => ({ output: "one" }))));
    const stored = readResult(first.resultsDir, "a");
    ok(typeof stored.key === "string" && stored.key.length > 0, "the result must record its task key");
    const second = loadPlan(dir, one("inspect"));
    const spawn = fakeSpawnFactory(() => ({ output: "two" }));
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 0, "an unchanged task must not re-dispatch");
    equal(readResult(second.resultsDir, "a").key, stored.key, "the key is stable across runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a result with no key — written before caching was keyed — still skips", async () => {
  const dir = tmp();
  try {
    const first = loadPlan(dir, one("inspect"));
    await runPlan(first, CFG, makeIo(fakeSpawnFactory(() => ({ output: "one" }))));
    const legacy = readResult(first.resultsDir, "a");
    delete legacy.key;
    writeFileSync(resultPath(first.resultsDir, "a"), JSON.stringify(legacy, null, 2) + "\n");
    const second = loadPlan(dir, one("inspect"));
    const spawn = fakeSpawnFactory(() => ({ output: "two" }));
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 0, "a keyless legacy result must stay valid — upgrading never re-spends an in-flight run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a forEach clone whose item changed re-runs, not the cached clone", async () => {
  const dir = tmp();
  try {
    // The item list only changes when `src` re-runs, so `src` must change too —
    // that re-runs the parent, and the clone is then judged on its own key.
    const body = (src) => ({
      tasks: [
        { id: "src", prompt: src, provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "fix", prompt: "fix {{item.f}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["src"], forEach: { from: "src", maxItems: 5 } },
      ],
    });
    const first = loadPlan(dir, body("list files"));
    const list = (files) => (call) =>
      promptOf(call).startsWith("list files") ? { output: JSON.stringify(files) } : { output: "done" };
    await runPlan(first, CFG, makeIo(fakeSpawnFactory(list([{ f: "a.mjs" }]))));
    equal(readResult(first.resultsDir, "fix[0]").prompt, "fix a.mjs");
    const second = loadPlan(dir, body("list files again"));
    const spawn = fakeSpawnFactory(list([{ f: "b.mjs" }]));
    await runPlan(second, CFG, makeIo(spawn));
    equal(readResult(second.resultsDir, "fix[0]").prompt, "fix b.mjs", "a clone whose item changed must re-run");
    ok(spawn.calls.some((c) => promptOf(c) === "fix b.mjs"), "the changed clone reached a leaf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a dependent of a re-run task re-runs too", async () => {
  const dir = tmp();
  try {
    const body = (prompt) => ({
      tasks: [
        { id: "a", prompt, provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "b", prompt: "check {{result:a}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["a"] },
      ],
    });
    await runPlan(loadPlan(dir, body("emit ONE")), CFG, makeIo(fakeSpawnFactory(() => ({ output: "one" }))));
    const second = loadPlan(dir, body("emit TWO"));
    const spawn = fakeSpawnFactory(() => ({ output: "two" }));
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 2, "a re-running upstream must re-run the dependent that consumed its output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Expansion strips forEach off the parent before its aggregate result is written;
// keyed on the stripped task, the parent never matched and every dependent re-ran.
test("resume: an unchanged forEach manifest replays whole — parent and its dependent included", async () => {
  const dir = tmp();
  try {
    const body = {
      tasks: [
        { id: "src", prompt: "list files", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "fix", prompt: "fix {{item.f}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["src"], forEach: { from: "src", maxItems: 5 } },
        { id: "dep", prompt: "check {{result:fix}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["fix"] },
      ],
    };
    const reply = (call) => (promptOf(call).startsWith("list files") ? { output: JSON.stringify([{ f: "a.mjs" }]) } : { output: "done" });
    await runPlan(loadPlan(dir, body), CFG, makeIo(fakeSpawnFactory(reply)));
    const second = loadPlan(dir, body);
    const spawn = fakeSpawnFactory(reply);
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 0, "an unchanged forEach parent must not invalidate its dependents");
    ok(!logOf(second).includes('"event":"cache-miss"'), "nothing changed, so nothing may be logged as changed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A forEach manifest node's childPlan is stripped off the parent at expansion, so the
// same pin must hold for it: unpinned, the parent never matched and its dependent re-ran.
test("resume: an unchanged forEach manifest node replays whole — parent and its dependent included", async () => {
  const dir = tmp();
  try {
    gitInit(dir);
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "one", prompt: "audit {{item}}", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const body = {
      tasks: [
        { id: "src", prompt: "list repos", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "audit", manifest: "child.json", after: ["src"], forEach: { from: "src", maxItems: 5 } },
        { id: "dep", prompt: "check {{result:audit}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["audit"] },
      ],
    };
    const reply = (call) => (promptOf(call).startsWith("list repos") ? { output: JSON.stringify(["r1", "r2"]) } : { output: "done" });
    const first = fakeSpawnFactory(reply);
    await runPlan(loadPlan(dir, body), CFG, makeIo(first));
    equal(first.calls.length, 4, "src, two child clones, dep");
    const second = loadPlan(dir, body);
    const spawn = fakeSpawnFactory(reply);
    await runPlan(second, CFG, makeIo(spawn));
    equal(spawn.calls.length, 0, "an unchanged manifest node must not invalidate its dependents");
    ok(!logOf(second).includes('"event":"cache-miss"'), "nothing changed, so nothing may be logged as changed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
