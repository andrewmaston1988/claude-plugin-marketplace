import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { effectivePlanDoc, argsFingerprint } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { writeManifestSnapshot, readResult } from "../src/results.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { DIGEST_ID } from "../src/digest.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  // allowedRoots gates Claude too now; every fixture lives under tmpdir.
  providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-persist-"));
}

// Read-only leaves default to a snapshot tree, which needs a repo with a commit.
function gitInit(dir) {
  if (existsSync(join(dir, ".git"))) return;
  const g = (a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, windowsHide: true });
  g(["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g(["add", "seed.txt"]);
  g(["commit", "-q", "-m", "init"]);
}

// A loadManifest-built plan: normalized tasks, args substituted, explicit
// resultsDir so nothing lands in the real swarm home.
function loadPlan(dir, body, { args, ref } = {}) {
  gitInit(dir);
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ resultsDir: join(dir, "run"), ...body }));
  return loadManifest(p, CFG, dir, {
    args,
    ...(ref ? { fromRegistry: true, ref } : {}),
  });
}

const snapshotOf = (plan) => JSON.parse(readFileSync(join(plan.resultsDir, "manifest.json"), "utf8"));

// ── effectivePlanDoc ──────────────────────────────────────────────────────────

test("effectivePlanDoc: resolved strip shape — set fields kept, empties omitted, digest/goal included", () => {
  const dir = tmp();
  try {
    const plan = loadPlan(dir, {
      goal: "audit the thing",
      tasks: [
        { id: "a", prompt: "scan {{args.base}}", provider: "claude", model: "claude-haiku-4-5-20251001" },
        {
          id: "b", prompt: "verify {{result:a}}", provider: "claude", model: "claude-sonnet-5", after: ["a"],
          returns: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
        },
      ],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "summarize" },
    }, { args: { base: "master" } });
    const doc = effectivePlanDoc(plan);
    equal(doc.goal, "audit the thing");
    equal(doc.resultsDir, plan.resultsDir);
    equal(doc.tasks[0].prompt, "scan master"); // args substituted before the doc is built
    deepEqual(doc.tasks[1].after, ["a"]);
    equal(doc.tasks[1].returns.required[0], "verdict");
    equal(doc.digest.model, "claude-haiku-4-5-20251001");
    // normalized-empty fields never serialize
    ok(!("after" in doc.tasks[0]), "empty after omitted");
    ok(!("when" in doc.tasks[0]), "unset when omitted");
    ok(!("forEach" in doc.tasks[0]), "unset forEach omitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectivePlanDoc: provider identity survives primary, fallback, child, and digest persistence", () => {
  const dir = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true },
        claude: { enabled: true, allowedRoots: [dir] },
        ollama: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, allowedRoots: [dir] },
      },
    };
    const path = join(dir, "provider-plan.json");
    writeFileSync(path, JSON.stringify({
      tasks: [{ id: "a", prompt: "inspect", model: "gpt-5-codex", provider: "codex", fallbackProvider: "claude", fallbackModel: "claude-haiku-4-5-20251001" }],
      digest: { model: "gpt-5-codex", provider: "codex" },
    }));
    const plan = loadManifest(path, cfg, dir);
    const doc = effectivePlanDoc(plan);
    equal(doc.tasks[0].provider, "codex");
    equal(doc.tasks[0].fallbackProvider, "claude");
    equal(doc.digest.provider, "codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectivePlanDoc: records the run's cwd — prune's repo-resolution fallback when no worktree survives to ask", () => {
  const dir = tmp();
  try {
    const plan = loadPlan(dir, { tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] });
    const doc = effectivePlanDoc(plan);
    equal(doc.cwd, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectivePlanDoc: records args, argsFingerprint, and registry ref; all absent for a bare-path run", () => {
  const dir = tmp();
  try {
    const args = { base: "master", n: 3 };
    const plan = loadPlan(dir, { tasks: [{ id: "a", prompt: "diff {{args.base}} top {{args.n}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] },
      { args, ref: "nightly-audit" });
    const doc = effectivePlanDoc(plan);
    deepEqual(doc.args, args);
    equal(doc.argsFingerprint, argsFingerprint(args));
    equal(doc.ref, "nightly-audit");

    const dir2 = tmp();
    try {
      const bare = loadPlan(dir2, { tasks: [{ id: "a", prompt: "x", provider: "claude", model: "claude-haiku-4-5-20251001" }] });
      const doc2 = effectivePlanDoc(bare);
      ok(!("args" in doc2), "no args key for a bare run");
      ok(!("argsFingerprint" in doc2), "no fingerprint for a bare run");
      ok(!("ref" in doc2), "no ref for a path run");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectivePlanDoc: child manifests nest under `child` with their resolved prompts", () => {
  const dir = tmp();
  try {
    const childPath = join(dir, "child.json");
    writeFileSync(childPath, JSON.stringify({
      tasks: [{ id: "scan", prompt: "scan {{args.base}}", provider: "claude", model: "claude-haiku-4-5-20251001" }],
    }));
    const plan = loadPlan(dir, {
      tasks: [{ id: "node", manifest: "child.json" }],
    }, { args: { base: "master" } });
    const doc = effectivePlanDoc(plan);
    equal(doc.tasks[0].child[0].prompt, "scan master");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest: returned plan exposes args and ref", () => {
  const dir = tmp();
  try {
    const args = { base: "master" };
    const plan = loadPlan(dir, { tasks: [{ id: "a", prompt: "on {{args.base}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] },
      { args, ref: "saved-name" });
    deepEqual(plan.args, args);
    equal(plan.ref, "saved-name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── writeManifestSnapshot ─────────────────────────────────────────────────────

test("writeManifestSnapshot: pretty-printed manifest.json with trailing newline; second write overwrites", () => {
  const dir = tmp();
  try {
    const p = writeManifestSnapshot(dir, { goal: "one", tasks: [] });
    equal(p, join(dir, "manifest.json"));
    const raw = readFileSync(p, "utf8");
    ok(raw.endsWith("\n"), "trailing newline");
    ok(raw.includes("\n  "), "pretty-printed");
    equal(JSON.parse(raw).goal, "one");
    writeManifestSnapshot(dir, { goal: "two", tasks: [] });
    equal(JSON.parse(readFileSync(p, "utf8")).goal, "two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runPlan persistence ───────────────────────────────────────────────────────

test("runPlan: manifest.json written at dispatch, before any leaf launches; content = effectivePlanDoc", async () => {
  const dir = tmp();
  try {
    let snapshotSeenAtLaunch = null;
    const plan = loadPlan(dir, { tasks: [{ id: "a", prompt: "say {{args.word}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] },
      { args: { word: "hello" } });
    const spawn = fakeSpawnFactory(() => {
      snapshotSeenAtLaunch = existsSync(join(plan.resultsDir, "manifest.json"));
      return { output: "hello" };
    });
    await runPlan(plan, CFG, makeIo(spawn));
    equal(snapshotSeenAtLaunch, true, "snapshot must exist before the first leaf spawns");
    const doc = snapshotOf(plan);
    equal(doc.tasks[0].prompt, "say hello");
    deepEqual(doc, JSON.parse(JSON.stringify(effectivePlanDoc(plan))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaf result records the exact prompt sent ({{result:dep}} inlined)", async () => {
  const dir = tmp();
  try {
    const plan = loadPlan(dir, {
      tasks: [
        { id: "a", prompt: "emit the codeword", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "b", prompt: "check {{result:a}} carefully", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["a"] },
      ],
    });
    const spawn = fakeSpawnFactory((call) => promptOf(call).startsWith("emit") ? { output: "XYZZY" } : { output: "ok" });
    await runPlan(plan, CFG, makeIo(spawn));
    const b = readResult(plan.resultsDir, "b");
    equal(b.prompt, "check XYZZY carefully");
    const sent = spawn.calls.map(promptOf).find((p) => p.startsWith("check"));
    equal(b.prompt, sent, "persisted prompt is byte-equal to the sent prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach clones each record their item-substituted prompt", async () => {
  const dir = tmp();
  try {
    const plan = loadPlan(dir, {
      tasks: [
        { id: "src", prompt: "list files", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "fix", prompt: "fix {{item.f}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["src"], forEach: { from: "src", maxItems: 5 } },
      ],
    });
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "list files" ? { output: JSON.stringify([{ f: "a.mjs" }, { f: "b.mjs" }]) } : { output: "done" });
    await runPlan(plan, CFG, makeIo(spawn));
    equal(readResult(plan.resultsDir, "fix[0]").prompt, "fix a.mjs");
    equal(readResult(plan.resultsDir, "fix[1]").prompt, "fix b.mjs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spliced child leaves record their remapped prompts; digest records its prompt", async () => {
  const dir = tmp();
  try {
    const childPath = join(dir, "child.json");
    writeFileSync(childPath, JSON.stringify({
      tasks: [
        { id: "scan", prompt: "child scan", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "sum", prompt: "sum of {{result:scan}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["scan"] },
      ],
    }));
    const plan = loadPlan(dir, {
      tasks: [{ id: "node", manifest: "child.json" }],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "wrap up" },
    });
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "child scan" ? { output: "SCANOUT" } : { output: "d" });
    await runPlan(plan, CFG, makeIo(spawn));
    equal(readResult(plan.resultsDir, "node~scan").prompt, "child scan");
    equal(readResult(plan.resultsDir, "node~sum").prompt, "sum of SCANOUT");
    const digest = readResult(plan.resultsDir, DIGEST_ID);
    ok(typeof digest.prompt === "string" && digest.prompt.length > 0, "digest prompt persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute steps and aggregates carry no prompt field", async () => {
  const dir = tmp();
  try {
    const plan = loadPlan(dir, {
      tasks: [
        { id: "src", prompt: "list", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "count", compute: "deps['src']", after: ["src"] },
        { id: "fix", prompt: "fix {{item}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["src"], forEach: { from: "src", maxItems: 5 } },
      ],
    });
    const spawn = fakeSpawnFactory((call) =>
      promptOf(call) === "list" ? { output: JSON.stringify(["x"]) } : { output: "done" });
    await runPlan(plan, CFG, makeIo(spawn));
    ok(!("prompt" in readResult(plan.resultsDir, "count")), "compute result has no prompt");
    ok(!("prompt" in readResult(plan.resultsDir, "fix")), "forEach aggregate has no prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: snapshot re-written at each dispatch; skipped leaves keep their persisted prompt", async () => {
  const dir = tmp();
  try {
    const body = { tasks: [{ id: "a", prompt: "say {{args.word}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] };
    const plan = loadPlan(dir, body, { args: { word: "hello" } });
    const spawn = fakeSpawnFactory(() => ({ output: "hello" }));
    await runPlan(plan, CFG, makeIo(spawn));
    // clobber the snapshot, then resume the same dir: dispatch restores it
    writeFileSync(join(plan.resultsDir, "manifest.json"), "{}\n");
    const spawn2 = fakeSpawnFactory(() => ({ output: "hello again" }));
    await runPlan(plan, CFG, makeIo(spawn2));
    equal(snapshotOf(plan).tasks[0].prompt, "say hello");
    equal(spawn2.calls.length, 0, "prior ok result skipped, not re-run");
    equal(readResult(plan.resultsDir, "a").prompt, "say hello", "skipped leaf keeps its prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
