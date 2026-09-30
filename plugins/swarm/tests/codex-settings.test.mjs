// Task `settings` and the leaf write guard on the Codex path. A Codex leaf has
// no `--settings`; its two routes are the spawn env (settings.env) and the
// plugin's own PreToolUse hook, fed per-leaf roots through SWARM_WRITE_GUARD_ROOTS.
// Every row drives the real runTask with a stub io.spawn and reads the call it made.
import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../src/scheduler.mjs";
import { buildDigestTask, scratchPath } from "../src/digest.mjs";
import { buildCodexInvocation, defaultCodexProviderAdapter } from "../src/codex.mjs";
import { CFG, tmp, task, fakeSpawnFactory, makeIo } from "./helpers/scheduler-fixtures.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { writeManifest, errorsOf, claudeTask, writerTask } from "./helpers/manifest-fixtures.mjs";

// A canonical Codex transcript, so a row that asserts on the RESULT is not
// reading a parser failure as if it were the dispatch's own verdict.
const CODEX_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
  JSON.stringify({ type: "response.completed", response: {} }),
].join("\n") + "\n";

const codexCfg = (root) => ({
  providers: {
    claude: { enabled: true, allowedRoots: [root] },
    codex: { enabled: true, path: "codex", allowedRoots: [root] },
  },
  timeoutMs: 600000,
});

// loadManifest refuses every task when provider.allowedRoots is unset, so the
// manifest-level rows need a root that covers the temp dir they author in.
const guardedCfg = (root) => ({ ...CFG, provider: { ...CFG.provider, allowedRoots: [root] } });

// Drive runTask and hand back both the spawned call and the settled result.
async function capture(t, cfg, resultsDir, parentEnv = {}) {
  const spawn = fakeSpawnFactory(() => ({ output: CODEX_STREAM }));
  const io = makeIo(spawn);
  Object.assign(io.env, parentEnv);
  const r = await runTask(t, "go", cfg, io, null, {}, { resultsDir });
  return { call: spawn.calls[0], calls: spawn.calls, r };
}

const rootsOf = (call) => JSON.parse(call.opts.env.SWARM_WRITE_GUARD_ROOTS);
const claudeSettingsOf = (call) => JSON.parse(call.args[call.args.indexOf("--settings") + 1]);
const guardCommandOf = (call) => claudeSettingsOf(call).hooks.PreToolUse[0].hooks[0].command;

// ── the guard's roots reach a Codex leaf through the spawn env ─────────────────

test("Codex writer: runTask sets SWARM_WRITE_GUARD_ROOTS to its tree and outputDir; a reader gets an empty list", async () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    const cfg = codexCfg(dir);
    const writer = await capture(task("w", {
      provider: "codex", model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: dir, originalCwd: dir, worktreeName: "w", outputDir: join(dir, "artefacts"),
    }), cfg, resultsDir);
    deepEqual(rootsOf(writer.call), [join(resultsDir, "wt-w"), join(dir, "artefacts")]);
    // The same list is what the adapter grants as --add-dir: one root list, two translations.
    const granted = writer.call.args.reduce((acc, v, i) => (v === "--add-dir" ? [...acc, writer.call.args[i + 1]] : acc), []);
    ok(granted.includes(join(resultsDir, "wt-w")), writer.call.args.join(" "));

    const reader = await capture(task("r", {
      provider: "codex", model: "gpt-5-codex", allowedTools: "Read,Grep,Glob",
      cwd: dir, originalCwd: dir,
    }), cfg, resultsDir);
    equal(reader.call.opts.env.SWARM_WRITE_GUARD_ROOTS, "", "a reader has no roots — and the var is still set, so nothing can inherit one");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SWARM_WRITE_GUARD_ROOTS: a parent's value never leaks into a leaf, writer or reader", async () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    const cfg = codexCfg(dir);
    const leak = '["C:/code/evil"]';
    const reader = await capture(task("r", {
      provider: "codex", model: "gpt-5-codex", allowedTools: "Read,Grep,Glob", cwd: dir, originalCwd: dir,
    }), cfg, resultsDir, { SWARM_WRITE_GUARD_ROOTS: leak });
    equal(reader.call.opts.env.SWARM_WRITE_GUARD_ROOTS, "", "an inherited value would widen every reader's guard");

    const writer = await capture(task("w", {
      provider: "codex", model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: dir, originalCwd: dir, worktreeName: "w",
    }), cfg, resultsDir, { SWARM_WRITE_GUARD_ROOTS: leak });
    deepEqual(rootsOf(writer.call), [join(resultsDir, "wt-w")], "the engine's own roots win over the inherited value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forEach clone: roots name the clone's OWN tree — Codex env and Claude --settings both", async () => {
  // deterministic-steps renames each clone to `<id>-<i>` after normalize, so roots
  // frozen at normalize name a tree the clone never runs in and every write is denied.
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    const clone = (over) => task("fix-0", {
      allowedTools: "Read,Write", cwd: dir, originalCwd: dir, worktreeName: "fix-0", ...over,
    });

    const codexCall = await capture(clone({ provider: "codex", model: "gpt-5-codex" }), codexCfg(dir), resultsDir);
    deepEqual(rootsOf(codexCall.call), [join(resultsDir, "wt-fix-0")]);

    const claudeCall = await capture(clone({ provider: "claude", model: "claude-haiku-4-5-20251001" }), CFG, resultsDir);
    const command = guardCommandOf(claudeCall.call);
    ok(command.includes(`"${join(resultsDir, "wt-fix-0")}"`), command);
    ok(!command.includes(`"${join(resultsDir, "wt-fix")}"`), `the parent's name was used: ${command}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the Claude path is unchanged, and normalize no longer pre-injects ──────────

test("Claude writer: runTask still merges the guard into --settings, rooted at its tree", async () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    const { call } = await capture(task("w", {
      provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Edit,Bash",
      cwd: dir, originalCwd: dir, worktreeName: "w",
    }), CFG, resultsDir);
    const entry = claudeSettingsOf(call).hooks.PreToolUse[0];
    equal(entry.matcher, "Write|Edit|NotebookEdit");
    match(entry.hooks[0].command, /leaf-write-guard\.mjs/);
    ok(entry.hooks[0].command.includes(`"${join(resultsDir, "wt-w")}"`), entry.hooks[0].command);
    equal(call.opts.env.SWARM_WRITE_GUARD_ROOTS, "", "the Codex env route stays inert on a Claude leaf");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalize no longer injects settings.hooks for a writer — settings passes through as authored", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask({ settings: { env: { OTHER: "x" } } })] });
    const planTask = loadManifest(p, guardedCfg(dir), dir).tasks[0];
    deepEqual(planTask.settings, { env: { OTHER: "x" } }, "roots are computed at spawn now, so normalize writes nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the quota fallback flips provider in place; roots follow ───────────────────

test("fallback: a Claude writer that falls back to Codex dispatches with env roots, no settings refusal", async () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    // Exactly the state launch.mjs leaves behind: `task.provider = next.provider`.
    // The Claude-authored settings ride along, and must no longer be refused.
    const { call, r } = await capture(task("fb", {
      provider: "codex", model: "gpt-5-codex", allowedTools: "Read,Edit,Bash",
      cwd: dir, originalCwd: dir, worktreeName: "fb", settings: { env: { OTHER: "x" } },
    }), codexCfg(dir), resultsDir);
    ok(!/dispatch error/.test(r.output), r.output);
    deepEqual(rootsOf(call), [join(resultsDir, "wt-fb")]);
    equal(call.opts.env.OTHER, "x", "the task's own env reaches the Codex leaf");
    ok(!call.args.includes("--settings"), call.args.join(" "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fallback: a Codex writer that falls back to Claude gets the --settings guard", async () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    const { call, r } = await capture(task("fb", {
      provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Edit,Bash",
      cwd: dir, originalCwd: dir, worktreeName: "fb", settings: { env: { OTHER: "x" } },
    }), CFG, resultsDir);
    ok(!/dispatch error/.test(r.output), r.output);
    const settings = claudeSettingsOf(call);
    ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(`"${join(resultsDir, "wt-fb")}"`), settings.hooks.PreToolUse[0].hooks[0].command);
    equal(settings.env.OTHER, "x", "the task's own env survives the merge");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the generated report digest ───────────────────────────────────────────────

test("Codex report digest: env roots are its scratch dir and its report file", async () => {
  const dir = tmp();
  try {
    const resultsDir = join(dir, "run");
    const digest = buildDigestTask({
      cwd: dir, resultsDir, goal: "g",
      tasks: [{ id: "a", model: "glm-4.6:cloud", timeoutMs: 600000 }],
      digest: { provider: "codex", model: "gpt-5-codex", report: true },
    });
    const { call } = await capture(digest, codexCfg(dir), resultsDir);
    deepEqual(rootsOf(call), [scratchPath(resultsDir), join(resultsDir, "report.md")]);
    equal(call.opts.cwd, scratchPath(resultsDir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the Codex adapter's own contract ──────────────────────────────────────────

test("buildCodexInvocation env: cfg.env overlaid by task settings.env, plus the guard roots", () => {
  const dir = tmp();
  try {
    const cfg = {
      providers: {
        codex: { enabled: true, path: "codex", allowedRoots: [dir], env: { SHARED: "cfg", CFG_ONLY: "1" } },
      },
    };
    const base = { provider: "codex", model: "gpt-5-codex", cwd: dir, originalCwd: dir, allowedTools: "Read" };
    const merged = buildCodexInvocation({ ...base, settings: { env: { SHARED: "task", TASK_ONLY: "2" } } }, "go", { config: cfg });
    equal(merged.env.SHARED, "task", "the task's value wins");
    equal(merged.env.CFG_ONLY, "1", "the provider's own env survives");
    equal(merged.env.TASK_ONLY, "2");
    equal(merged.env.SWARM_WRITE_GUARD_ROOTS, "", "no write targets, no roots — and the var is still cleared");

    const guarded = buildCodexInvocation({
      ...base, allowedTools: "Read,Write", writeRoots: [{ path: join(dir, "wt-w"), kind: "directory" }],
    }, "go", { config: cfg });
    deepEqual(JSON.parse(guarded.env.SWARM_WRITE_GUARD_ROOTS), [join(dir, "wt-w")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex accepts settings.env and refuses every other key by name", () => {
  const adapter = defaultCodexProviderAdapter;
  deepEqual(adapter.validateTask({ model: "gpt-5-codex", settings: { env: { X: "1" } } }), []);
  deepEqual(adapter.validateTask({ model: "gpt-5-codex" }), []);

  const problems = adapter.validateTask({
    model: "gpt-5-codex",
    settings: { env: { X: "1" }, permissions: { allow: ["Read"] }, model: "x" },
  });
  equal(problems.length, 1, problems.join("\n"));
  match(problems[0], /permissions/);
  match(problems[0], /model/);
  match(problems[0], /env/, "the message must name env as the one key Codex accepts");
});

test("settings.env may not set SWARM_WRITE_GUARD_ROOTS, and that refusal suggests no leafGuard opt-out", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ cwd: ".", settings: { env: { SWARM_WRITE_GUARD_ROOTS: "[]" } } })] });
    const errs = errorsOf(() => loadManifest(p, guardedCfg(dir), dir));
    const row = errs.find((e) => e.includes("SWARM_WRITE_GUARD_ROOTS"));
    ok(row, errs.join("\n"));
    ok(!/leafGuard/.test(row), `a task cannot opt out of the write guard: ${row}`);
    ok(/outputDir/.test(row), `the remedy names the roots the engine sets: ${row}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the SWARM_LEAF* keys keep their leafGuard opt-out remedy", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ cwd: ".", settings: { env: { SWARM_LEAF: "0" } } })] });
    const row = errorsOf(() => loadManifest(p, guardedCfg(dir), dir)).find((e) => e.includes("SWARM_LEAF'"));
    ok(row, "the SWARM_LEAF key must still be refused");
    ok(/"leafGuard": false/.test(row), row);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
