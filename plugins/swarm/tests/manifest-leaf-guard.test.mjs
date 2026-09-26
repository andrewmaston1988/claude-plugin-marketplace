// Leaf guards: the project guard a task inherits from its repo name — probe,
// print, and explicit opt-out — and the write guard injected into a writer's own
// `--settings` so a leaf cannot rewrite it.
import { test } from "node:test";
import { equal, ok, deepEqual, match } from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_TOOLS, hasWriteTools } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask, writerTask } from "./helpers/manifest-fixtures.mjs";

// ── leaf guards (swarm-leaf-guard-no-cargo) ────────────────────────────────────
// A stub io skips the real spawnSync/git — the probe/print/match machinery is
// under test, not any actual guard command or repo.
function stubIo(over = {}) {
  return { spawnSync: () => ({ status: 0, stderr: "" }), stdout: () => {}, ...over };
}

test("normalizeTasks: a task under a projects entry matching its repo name carries leafGuard; false opts out; any other value errors", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "guard-cmd" } }] };

    const on = writeManifest(dir, { tasks: [claudeTask({ cwd: "." })] }, "on.json");
    const planOn = loadManifest(on, cfg, dir, { io: stubIo() });
    deepEqual(planOn.tasks[0].leafGuard, { name, command: "guard-cmd" });

    const off = writeManifest(dir, { tasks: [claudeTask({ cwd: ".", leafGuard: false })] }, "off.json");
    const planOff = loadManifest(off, cfg, dir, { io: stubIo() });
    equal(planOff.tasks[0].leafGuard, undefined);

    const badTrue = writeManifest(dir, { tasks: [claudeTask({ leafGuard: true })] }, "bad-true.json");
    ok(errorsOf(() => loadManifest(badTrue, cfg, dir, { io: stubIo() }))
      .some((e) => e.includes("task 'a'") && e.includes("leafGuard") && e.includes('"leafGuard": false')));

    const badStr = writeManifest(dir, { tasks: [claudeTask({ leafGuard: "off" })] }, "bad-str.json");
    ok(errorsOf(() => loadManifest(badStr, cfg, dir, { io: stubIo() }))
      .some((e) => e.includes("task 'a'") && e.includes("leafGuard") && e.includes('"leafGuard": false')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeTasks: the repo name is resolved via io.repoToplevel (git seam), not the task's cwd path", () => {
  const dir = tmp();
  try {
    // repoToplevel reports a DIFFERENT path than dir; the project name must
    // match that reported repo's basename, not dir's own basename.
    const cfg = { ...CFG, provider: { allowedRoots: [dir, join(dir, "..", "reported-repo")] }, projects: [{ name: "reported-repo", hooks: { preToolUse: "guard-cmd" } }] };
    const p = writeManifest(dir, { tasks: [claudeTask({ cwd: "." })] });
    const plan = loadManifest(p, cfg, dir, { io: stubIo({ repoToplevel: () => join(dir, "..", "reported-repo") }) });
    deepEqual(plan.tasks[0].leafGuard, { name: "reported-repo", command: "guard-cmd" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeTasks: project name match is case-insensitive on Windows", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name: name.toUpperCase(), hooks: { preToolUse: "guard-cmd" } }] };
    const p = writeManifest(dir, { tasks: [claudeTask({ cwd: "." })] });
    const plan = loadManifest(p, cfg, dir, { io: stubIo() });
    if (process.platform === "win32") {
      deepEqual(plan.tasks[0].leafGuard, { name: name.toUpperCase(), command: "guard-cmd" });
    } else {
      equal(plan.tasks[0].leafGuard, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compute, manifest and integrate nodes never carry a leafGuard even under a guarded project", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "guard-cmd" } }] };
    writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: [claudeTask({ id: "leaf", cwd: "." })] }));
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", allowedTools: "Read,Edit" }),
      claudeTask({ id: "y", allowedTools: "Bash" }),
      { id: "calc", after: ["x"], compute: "true" },
      { id: "sub", manifest: "child.json" },
      { id: "join", after: ["x", "y"], integrate: { into: "feat", from: ["x", "y"] } },
    ] });
    const plan = loadManifest(p, cfg, dir, { io: stubIo() });
    equal(plan.tasks.find((t) => t.id === "calc").leafGuard, undefined);
    equal(plan.tasks.find((t) => t.id === "join").leafGuard, undefined);
    equal(plan.tasks.find((t) => t.id === "sub").leafGuard, undefined, "the manifest node itself is agentless");
    // the child's own leaf tasks are real spawned leaves — they still inherit
    // the guard for whatever project their (inherited) cwd resolves to
    deepEqual(plan.tasks.find((t) => t.id === "sub").childPlan.tasks[0].leafGuard, { name, command: "guard-cmd" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("leaf guard validate probe: a non-zero exit fails validation naming the project, command, exit code and stderr; runs once per distinct guard", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "broken-guard" } }] };
    const calls = [];
    const io = stubIo({
      spawnSync: (command, opts) => {
        calls.push({ command, opts });
        return { status: 3, stderr: "guard blew up\n" };
      },
    });
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "a", cwd: "." }),
      claudeTask({ id: "b", cwd: "." }),
    ] });
    const errs = errorsOf(() => loadManifest(p, cfg, dir, { io }));
    ok(errs.some((e) => e.includes(name) && e.includes("broken-guard") && e.includes("3") && e.includes("guard blew up")));
    equal(calls.length, 1, "the probe runs once per distinct guard, not per task");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("leaf guard: a passing probe prints one line per guarded task and an opt-out line for a task that declines it", () => {
  const dir = tmp();
  const name = basename(dir);
  try {
    const cfg = { ...CFG, provider: { allowedRoots: [dir] }, projects: [{ name, hooks: { preToolUse: "guard-cmd" } }] };
    const lines = [];
    const io = stubIo({ stdout: (line) => lines.push(line) });
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "a", cwd: "." }),
      claudeTask({ id: "b", cwd: ".", leafGuard: false }),
    ] });
    loadManifest(p, cfg, dir, { io });
    ok(lines.includes(`leaf guard: ${name} → guard-cmd`));
    ok(lines.includes("leaf guard: off (task opt-out)"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── leaf write guard ──────────────────────────────────────────────────────────
// A worktree confines a leaf's cwd, not an absolute path, so a leaf could write
// across the operator's live checkout. The guard is
// INJECTED into each writer's own `--settings`, so the leaf cannot rewrite it.

test("write guard: attached to a write-capable leaf, rooted at its own worktree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask()] });
    const plan = loadManifest(p, CFG, dir);
    const guard = plan.tasks[0].settings?.hooks?.PreToolUse?.[0];
    ok(guard, `a writer must carry the guard: ${JSON.stringify(plan.tasks[0].settings)}`);
    equal(guard.matcher, "Write|Edit|NotebookEdit");
    const command = guard.hooks[0].command;
    match(command, /leaf-write-guard\.mjs/);
    // The root is the worktree the scheduler will create for this task.
    match(command, /wt-a/);
    equal(guard.hooks[0].type, "command");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: absent from a read-only leaf, which has no tree to be confined to", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask()] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks[0].allowedTools, DEFAULT_TOOLS);
    equal(plan.tasks[0].settings, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: absent from a read-only leaf even when it declares an outputDir", () => {
  // The row above passes on its own for the wrong reason: a reader derives no tree,
  // so its root list is empty and applyWriteGuard no-ops. outputDir is the one root a
  // reader CAN have, which makes hasWriteTools the only thing withholding the guard.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ outputDir: "artefacts" })] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks[0].outputDir, join(dir, "artefacts"), "the root would exist if the predicate let it through");
    equal(plan.tasks[0].settings, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: outputDir is a second allowed root — it resolves into the live checkout", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask({ outputDir: "artefacts" })] });
    const plan = loadManifest(p, CFG, dir);
    const command = plan.tasks[0].settings.hooks.PreToolUse[0].hooks[0].command;
    match(command, /wt-a/);
    match(command, /artefacts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: a task's own hooks cannot replace it", () => {
  const dir = tmp();
  try {
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "node mine.mjs" }] };
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask({
      settings: { env: { OTHER: "x" }, hooks: { PreToolUse: [own], Stop: [{ hooks: [{ type: "command", command: "node stop.mjs" }] }] } },
    })] });
    const plan = loadManifest(p, CFG, dir);
    const hooks = plan.tasks[0].settings.hooks;
    equal(hooks.PreToolUse.length, 2, "the engine's entry is prepended, not replaced");
    equal(hooks.PreToolUse[0].matcher, "Write|Edit|NotebookEdit");
    deepEqual(hooks.PreToolUse[1], own, "the task's own entry survives beside it");
    ok(hooks.Stop, "unrelated hook events survive");
    equal(plan.tasks[0].settings.env.OTHER, "x", "unrelated settings survive");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write guard: the emitted command actually denies when a shell runs it", () => {
  // Every other row asserts the command as a STRING; a wrong hook path or a root
  // list that never made it into the command would pass all of them. This runs it.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [writerTask()] });
    const command = loadManifest(p, CFG, dir).tasks[0].settings.hooks.PreToolUse[0].hooks[0].command;
    const payload = (filePath) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });
    const run = (filePath) => {
      const r = spawnSync(command, { shell: true, input: payload(filePath), encoding: "utf8" });
      equal(r.status, 0, `the emitted command must run — ${r.stderr}`);
      return r.stdout.trim();
    };
    const root = join(dir, "out", "wt-a");
    equal(run(join(root, "inside.txt")), "", "a write inside the leaf's own tree is allowed");
    const out = JSON.parse(run(join(dir, "escape.txt")));
    equal(out.hookSpecificOutput.permissionDecision, "deny", "a write outside it is denied");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
