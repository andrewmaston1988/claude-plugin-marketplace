// Report-mode digests: the authored digest block, the args that reach it, the win32
// command-line measurement, and the generated-digest dispatch validation that turns a
// provider-incompatible engine task into a validation error before scheduling.
import { test } from "node:test";
import { equal, ok, deepEqual, throws, match } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildDigestTask } from "../src/digest.mjs";
import { buildDispatch } from "../src/dispatch.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

test("digest.report: true and a steering string both survive to the plan", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: true },
    });
    equal(loadManifest(p, CFG, dir).digest.report, true);

    const p2 = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: "Lead with the security findings." },
    }, "plan2.json");
    equal(loadManifest(p2, CFG, dir).digest.report, "Lead with the security findings.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest.report rejects a non-boolean, non-string value", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: 3 },
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("digest.report")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// digest.instructions already gets args substitution; without the same treatment
// a {{args.x}} in the report steer survives verbatim into the leaf's prompt.
// The goal flows into the digest prompt and titles the report — an un-substituted
// {{args.x}} there disfigured every report's H1 (the live-run bug).
test("args substitute into the goal", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      goal: "audit the {{args.area}} surface",
      tasks: [claudeTask({ prompt: "look at {{args.area}}" })],
    });
    const plan = loadManifest(p, CFG, dir, { args: { area: "auth" } });
    equal(plan.goal, "audit the auth surface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args substitute into the digest.report steering string", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ prompt: "look at {{args.area}}" })],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: "Lead with {{args.area}}." },
    });
    const plan = loadManifest(p, CFG, dir, { args: { area: "auth" } });
    equal(plan.digest.report, "Lead with auth.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The digest leaf dispatches through the same buildDispatch/toSpawnable path as
// any other task (scheduler.mjs) — RED before the fix: checkCommandLineLengths
// only ever measured plan.tasks, so an oversized digest.instructions block
// passed validation even though the digest leaf could never actually spawn.
test("win32 command-line check: oversized digest.instructions fails validation naming the digest", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, claudePath: "C:\\fake\\claude.exe" };
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "x".repeat(32000) },
    });
    throws(
      () => loadManifest(p, cfg, dir, { io: { platform: "win32" } }),
      (e) => /digest/.test(e.message) && /command line/.test(e.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 command-line check: digest.instructions just under the cap passes", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, claudePath: "C:\\fake\\claude.exe" };
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "x".repeat(2000) },
    });
    const plan = loadManifest(p, cfg, dir, { io: { platform: "win32" } });
    equal(plan.digest.instructions.length, 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── generated-digest dispatch validation ──────────────────────────────────────

// A report digest under Codex is the case the engine used to discover at RUN time
// with durationMs: 0 — the win32 length helper swallows every buildDispatch throw.
const codexCfg = (dir) => ({
  ...CFG,
  providers: { claude: { enabled: true, allowedRoots: [dir] }, codex: { enabled: true, path: "codex", allowedRoots: [dir] } },
});

const codexReportManifest = (dir) => writeManifest(dir, {
  resultsDir: "out",
  tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5-codex", provider: "codex" }],
  digest: { provider: "codex", model: "gpt-5-codex", report: true },
});

test("generated digest: a Codex report manifest validates, and its argv carries no Claude settings", () => {
  const dir = tmp();
  try {
    const plan = loadManifest(codexReportManifest(dir), codexCfg(dir), dir);
    equal(plan.digest.provider, "codex");
    const digestTask = buildDigestTask(plan);
    const dispatch = buildDispatch(digestTask, digestTask.prompt, codexCfg(dir));
    ok(dispatch.argv.includes("--sandbox"), dispatch.argv.join(" "));
    ok(!dispatch.argv.includes("--settings"), "a Claude settings payload must never reach Codex");
    ok(!("settings" in digestTask));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The dispatch contract is platform-independent; only the LENGTH measurement is
// win32-specific. So a digest the length helper would reject on win32 still
// validates off win32 — the new check did not become a second win32 gate.
test("generated digest: the dispatch check is not the win32 length check", () => {
  const dir = tmp();
  try {
    const cfg = { ...codexCfg(dir), codexPath: "C:\\fake\\codex.exe" };
    const long = writeManifest(dir, {
      resultsDir: "out",
      tasks: [{ id: "codex", prompt: "inspect", model: "gpt-5-codex", provider: "codex" }],
      digest: { provider: "codex", model: "gpt-5-codex", report: true, instructions: "x".repeat(32000) },
    }, "long.json");
    const plan = loadManifest(long, cfg, dir, { io: { platform: "linux" } });
    equal(plan.digest.provider, "codex");
    throws(() => loadManifest(long, cfg, dir, { io: { platform: "win32" } }),
      (e) => /digest/.test(e.message) && /command line/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// An incompatible generated dispatch must be a VALIDATION error, not a task that
// dies in the scheduler: the engine's own task has no second reporter.
test("generated digest: an incompatible generated dispatch fails validation, naming the digest", () => {
  const dir = tmp();
  try {
    const runnerRegistry = {
      resolve: () => ({ id: "broken", buildInvocation: () => { throw new Error("cannot translate the digest"); } }),
    };
    const manifest = writeManifest(dir, {
      resultsDir: "out",
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", report: true },
    });
    // win32's platform-injected path proves the error is not the length helper's,
    // and the injected registry proves it comes from the dispatch construction.
    for (const platform of ["win32", "linux"]) {
      const errs = errorsOf(() => loadManifest(manifest, CFG, dir, {
        io: { platform, spawnSync: () => ({ status: 0, stderr: "" }), stdout: () => {} },
        runnerRegistry,
      }));
      ok(errs.some((e) => /digest/.test(e) && /cannot be dispatched/.test(e) && /cannot translate the digest/.test(e)), errs.join("\n"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ...and the digest's own governance denial is reported ONCE, not twice: the
// dispatch check rebuilds the same dispatch from the same config, so an ungated
// rebuild would report the identical denial a second time.
test("generated digest: a governance-denied digest is not reported twice", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [dir] }, codex: { enabled: true, allowedRoots: [] } } };
    const errs = errorsOf(() => loadManifest(codexReportManifest(dir), cfg, dir));
    // The leaf's denial and the digest's — one each, and no dispatch-contract error
    // on top of them.
    ok(errs.some((e) => /^task 'codex'/.test(e)), errs.join("\n"));
    equal(errs.filter((e) => /^digest:/.test(e)).length, 1, errs.join("\n"));
    ok(!errs.some((e) => /cannot be dispatched/.test(e)), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The generated digest carries the engine's write INTENT as typed targets; the
// Claude runner is what turns them into the injected PreToolUse guard, so the guard
// is asserted on the invocation rather than on the task.
test("write guard: present on the report-mode digest invocation, absent on the read-only one", () => {
  const dir = tmp();
  try {
    const body = (report) => ({
      resultsDir: "out",
      tasks: [claudeTask()],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", ...(report && { report: true }) },
    });

    const p1 = writeManifest(dir, body(false), "plain.json");
    const readOnly = buildDigestTask(loadManifest(p1, CFG, dir));
    equal("writeRoots" in readOnly, false, "a Read-only digest writes nothing to guard");
    equal(readOnly.settings, undefined);
    const readOnlyInvocation = buildDispatch(readOnly, readOnly.prompt, CFG, { _mcpTools: () => [] });
    ok(!readOnlyInvocation.argv.includes("--settings"), readOnlyInvocation.argv.join(" "));

    const p2 = writeManifest(dir, body(true), "report.json");
    const plan = loadManifest(p2, CFG, dir);
    const digestTask = buildDigestTask(plan);
    deepEqual(digestTask.writeRoots, [
      { path: join(plan.resultsDir, "scratch-__digest"), kind: "directory" },
      { path: join(plan.resultsDir, "report.md"), kind: "file" },
    ]);
    equal(digestTask.settings, undefined, "the task itself carries no provider wire format");
    const invocation = buildDispatch(digestTask, digestTask.prompt, CFG, { _mcpTools: () => [] });
    const command = JSON.parse(invocation.argv[invocation.argv.indexOf("--settings") + 1])
      .hooks.PreToolUse[0].hooks[0].command;
    match(command, /leaf-write-guard\.mjs/);
    // Its drafting directory and the one file it may write.
    match(command, /scratch-__digest/);
    match(command, /report\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
