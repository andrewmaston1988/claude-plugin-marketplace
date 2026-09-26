import { test } from "node:test";
import { equal, ok, deepEqual, throws, match, notEqual } from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { ValidationError, DEFAULT_TOOLS, isUnderRoot, hasWriteTools, guardFor, realRepoToplevel } from "../src/manifest.mjs";
import { spawnSync } from "node:child_process";
import { buildDigestTask } from "../src/digest.mjs";
import { buildDispatch } from "../src/dispatch.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask, writerTask } from "./helpers/manifest-fixtures.mjs";
import { getUsage, resetUsageMemo, saveCookie } from "../src/ollama-usage.mjs";
import { integrateCaps } from "../src/estimate.mjs";

test("fully valid manifest normalizes with defaults", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "out",
      tasks: [
        { id: "scan-a", prompt: "look", provider: "claude", model: "claude-haiku-4-5-20251001" },
        { id: "scan-b", prompt: "look more", provider: "claude", model: "claude-sonnet-5", effort: "max" },
        { id: "join", prompt: "combine {{result:scan-a}} and {{resultPath:scan-b}}", provider: "claude", model: "claude-opus-5", after: ["scan-a", "scan-b"] },
      ],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "focus on X" },
    });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.resultsDir, join(dir, "out"));
    equal(plan.concurrency, 4);
    equal(plan.tasks.length, 3);
    equal(plan.tasks[0].allowedTools, DEFAULT_TOOLS);
    equal(plan.tasks[0].cwd, dir);
    equal(plan.tasks[0].timeoutMs, 600000);
    deepEqual(plan.tasks[2].after, ["scan-a", "scan-b"]);
    equal(plan.digest.model, "claude-haiku-4-5-20251001");
    equal(plan.digest.instructions, "focus on X");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings must be a JSON object", () => {
  const dir = tmp();
  try {
    const p1 = writeManifest(dir, { tasks: [claudeTask({ settings: "x" })] });
    const errs = errorsOf(() => loadManifest(p1, CFG, dir));
    ok(errs.some((e) => e.includes("settings must be a JSON object")), errs.join("\n"));

    const p2 = writeManifest(dir, { tasks: [claudeTask({ settings: { env: {} } })] }, "ok.json");
    const plan = loadManifest(p2, CFG, dir);
    deepEqual(plan.tasks[0].settings, { env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings.env cannot forge or clear the leaf guard vars", () => {
  const dir = tmp();
  try {
    for (const key of ["SWARM_LEAF", "SWARM_LEAF_GUARD", "SWARM_LEAF_GUARD_PROJECT"]) {
      const p = writeManifest(dir, { tasks: [claudeTask({ settings: { env: { [key]: "" } } })] });
      const errs = errorsOf(() => loadManifest(p, CFG, dir));
      ok(errs.some((e) => e.includes("settings.env") && e.includes(key)), `${key}: ${errs.join("\n")}`);
    }

    // an unrelated key survives untouched
    const ok1 = writeManifest(dir, { tasks: [claudeTask({ settings: { env: { OTHER: "x" } } })] }, "ok.json");
    const plan = loadManifest(ok1, CFG, dir);
    deepEqual(plan.tasks[0].settings, { env: { OTHER: "x" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate ids rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask(), claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("duplicate id")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-filename-safe and reserved ids rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "bad/id" }),
        claudeTask({ id: "__digest" }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("filename-safe")));
    ok(errs.some((e) => e.includes("reserved")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing prompt/model reported", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "a" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("prompt is required")));
    ok(errs.some((e) => e.includes("model is required")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown after id rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ after: ["ghost"] })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("unknown dependency 'ghost'")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency cycle rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "a", after: ["b"] }),
        claudeTask({ id: "b", after: ["a"] }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("cycle")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("template ref to a non-dependency id rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "a" }),
        claudeTask({ id: "b", prompt: "use {{result:a}} and {{resultPath:c}}", after: [] }),
        claudeTask({ id: "c" }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("{{result:a}}")), errs.join("|"));
    ok(errs.some((e) => e.includes("{{resultPath:c}}")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effort resolves from the manifest, provider declaration, or medium", () => {
  const dir = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true, allowedRoots: [dir] },
        ollama: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, allowedRoots: [dir] },
      },
    };
    const good = writeManifest(dir, {
      tasks: [
        { id: "c", prompt: "p", model: "gpt-5.5", provider: "codex" },
        { id: "s", prompt: "p", model: "claude-sonnet-5", provider: "claude", effort: "xhigh" },
        { id: "h", prompt: "p", model: "claude-haiku-4-5-20251001", provider: "claude", effort: "max" },
        { id: "u", prompt: "p", model: "claude-opus-4-8", provider: "claude", effort: "max" },
      ],
    }, "good.json");
    const plan = loadManifest(good, cfg, dir, {
      cache: [
        { provider: "codex", model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
        { provider: "claude", model: "claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
        { provider: "claude", model: "claude-haiku-4-5-20251001", defaultEffort: undefined },
      ],
    });
    equal(plan.tasks.find((t) => t.id === "c").effort, "medium");
    equal(plan.tasks.find((t) => t.id === "s").effort, "xhigh");
    equal(plan.tasks.find((t) => t.id === "h").effort, "max");
    equal(plan.tasks.find((t) => t.id === "u").effort, "max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("declared effort contradictions name the model and allowed values, including fallback", () => {
  const dir = tmp();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [dir] },
        codex: { enabled: true, allowedRoots: [dir] },
      },
    };
    const cache = [{ provider: "codex", model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] }];
    const path = writeManifest(dir, {
      tasks: [claudeTask({ model: "claude-sonnet-5", effort: "max", fallbackModel: "gpt-5.5", fallbackProvider: "codex" })],
    });
    const errors = errorsOf(() => loadManifest(path, cfg, dir, { cache }));
    ok(errors.some((e) => e.includes("gpt-5.5") && e.includes("low, medium, high, xhigh")), errors.join("\n"));

    const xhigh = writeManifest(dir, {
      tasks: [{ id: "g", prompt: "p", model: "gpt-5.5", provider: "codex", effort: "xhigh" }],
    }, "xhigh.json");
    equal(loadManifest(xhigh, cfg, dir, { cache }).tasks[0].effort, "xhigh");

    const empty = writeManifest(dir, {
      tasks: [claudeTask({ effort: "" })],
    }, "empty.json");
    ok(errorsOf(() => loadManifest(empty, cfg, dir)).some((e) => /effort must be a non-empty string/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute, manifest, and integrate nodes carry no effort", () => {
  const dir = tmp();
  try {
    const child = writeManifest(dir, { tasks: [claudeTask({ id: "child" })] }, "child.json");
    const path = writeManifest(dir, {
      tasks: [
        { id: "compute", compute: "1 == 1" },
        { id: "writer", prompt: "write", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Edit" },
        { id: "integrate", after: ["writer"], integrate: { into: "feat", from: ["writer"] } },
        { id: "manifest", manifest: child },
      ],
    }, "agentless.json");
    const plan = loadManifest(path, CFG, dir);
    equal(plan.tasks.find((t) => t.id === "compute").effort, undefined);
    equal(plan.tasks.find((t) => t.id === "integrate").effort, undefined);
    equal(plan.tasks.find((t) => t.id === "manifest").effort, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── how a leaf's tree is derived ──────────────────────────────────────────────

test("the write tools alone decide the tree: every writer gets one, the reader none", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "res",
      tasks: [
        claudeTask({ id: "gen", allowedTools: "Read,Write" }),
        claudeTask({ id: "bash", allowedTools: "Bash" }),
        claudeTask({ id: "impl", allowedTools: "Read,Edit,Bash" }),
        claudeTask({ id: "ro", allowedTools: "Read,Grep" }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    for (const id of ["gen", "bash", "impl"]) {
      equal(byId[id].worktreeName, id, `${id} owns a tree named for itself`);
      ok(byId[id].branchScope, `${id}'s branch is run-scoped`);
      equal(byId[id].cwd, dir, "the declared cwd is untouched at normalise time");
    }
    equal(byId.ro.worktreeName, undefined);
    equal(byId.ro.branchScope, undefined);
    equal(byId.ro.cwd, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resultsDir default ────────────────────────────────────────────────────────

test("default resultsDir is <home>/runs/<encoded-repo-toplevel>/<stem>-1, reusing highest existing n for resume", () => {
  const dir = tmp();
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = join(dir, "home");
  const base = join(dir, "home", "runs", dir.replace(/[\\/:]/g, "-"));
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] }, "sweep.json");
    const plan1 = loadManifest(p, CFG, dir);
    equal(plan1.resultsDir, join(base, "sweep-1"));

    mkdirSync(join(base, "sweep-1"), { recursive: true });
    mkdirSync(join(base, "sweep-3"), { recursive: true });
    const plan2 = loadManifest(p, CFG, dir);
    equal(plan2.resultsDir, join(base, "sweep-3"));
  } finally {
    if (prevHome === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model-authored manifests: markdown fences around the JSON are tolerated", () => {
  const dir = tmp();
  try {
    const p = join(dir, "fenced.json");
    writeFileSync(p, "```json\n" + JSON.stringify({ tasks: [claudeTask()] }) + "\n```\n");
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable manifest throws ValidationError", () => {
  const dir = tmp();
  try {
    throws(() => loadManifest(join(dir, "missing.json"), CFG, dir), ValidationError);
    const p = join(dir, "broken.json");
    writeFileSync(p, "{ nope");
    throws(() => loadManifest(p, CFG, dir), ValidationError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

test("isUnderRoot: boundary-aware, separator-tolerant", () => {
  const root = join(tmpdir(), "rootdir");
  equal(isUnderRoot(join(root, "sub"), root), true);
  equal(isUnderRoot(root, root), true);
  equal(isUnderRoot(root + "extra", root), false);
  equal(isUnderRoot(root.replaceAll(sep, "/") + "/sub", root), true);
});

// io.repoToplevel stub: pretends `cwd` sits inside a repo whose root is `top`,
// or returns null (git failed) so guardFor falls back to basename(cwd).
function ioWithToplevel(top) {
  return { repoToplevel: () => top };
}
const ioNoGit = { repoToplevel: () => null };

test("guardFor: no projects -> undefined; matching repo name -> its command; unknown name -> undefined; Windows case-insensitive", () => {
  const repo = join(tmpdir(), "myrepo");
  const nested = join(repo, "sub");
  const elsewhere = join(tmpdir(), "elsewhere");
  equal(guardFor(repo, {}, ioNoGit), undefined);
  equal(guardFor(repo, { projects: [] }, ioNoGit), undefined);
  equal(guardFor(elsewhere, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit), undefined);
  // io.repoToplevel resolves the leaf's repo root; the project name matches its basename
  deepEqual(
    guardFor(nested, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioWithToplevel(repo)),
    { name: "myrepo", command: "cmd-a" },
  );
  // git fails -> falls back to the basename of originalCwd itself
  deepEqual(
    guardFor(repo, { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit),
    { name: "myrepo", command: "cmd-a" },
  );
  // a project with no preToolUse yields no guard
  equal(
    guardFor(repo, { projects: [{ name: "myrepo", hooks: {} }] }, ioNoGit),
    undefined,
  );
  if (process.platform === "win32") {
    deepEqual(
      guardFor(join(tmpdir(), "MYREPO"), { projects: [{ name: "myrepo", hooks: { preToolUse: "cmd-a" } }] }, ioNoGit),
      { name: "myrepo", command: "cmd-a" },
    );
  }
});

test("hasWriteTools detects each write tool, case-insensitive", () => {
  equal(hasWriteTools("Read,Grep"), false);
  equal(hasWriteTools("Read,Edit"), true);
  equal(hasWriteTools("write"), true);
  equal(hasWriteTools("Bash"), true);
  equal(hasWriteTools("NotebookEdit"), true);
  equal(hasWriteTools(undefined), false);
});






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

// ── run home: keyed on the repo toplevel ─────────────────────────────────────
test("run home: a non-repo dispatch is refused with the cd <repo> instruction", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { io: { repoToplevel: () => null } }));
    ok(errs.some((e) => e.includes("is not inside a git repository") && e.includes('swarm run "')), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run home: a non-repo dispatch is refused for a registry manifest too", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { fromRegistry: true, io: { repoToplevel: () => null } }));
    ok(errs.some((e) => e.includes("is not inside a git repository")), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function withHome(dir, fn) {
  const prev = process.env.SWARM_HOME;
  process.env.SWARM_HOME = join(dir, "home");
  try { fn(); } finally {
    if (prev === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = prev;
  }
}

// The run gate bounds the run's REPO, not just each leaf's cwd, so the fixtures below that
// stub a toplevel outside the tmpdir must let claude's roots cover the stubbed path.
const CFG_PROJ = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [tmpdir(), "C:/proj"] } } };

test("run home: a subdirectory dispatch is filed under the repo toplevel's key", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      const sub = join(dir, "sub");
      mkdirSync(sub);
      const p = writeManifest(dir, { tasks: [claudeTask()] }, "m.json");
      const plan = loadManifest(p, CFG_PROJ, sub, { io: { repoToplevel: () => "C:/proj/repo" } });
      equal(plan.resultsDir, join(dir, "home", "runs", "C--proj-repo", "m-1"));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run home: dispatches from the toplevel and a subdirectory resume the same run", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      const sub = join(dir, "sub");
      mkdirSync(sub);
      mkdirSync(join(dir, "home", "runs", "C--proj-repo", "m-1"), { recursive: true });
      const p = writeManifest(dir, { tasks: [claudeTask()] }, "m.json");
      const io = { repoToplevel: () => "C:/proj/repo" };
      const want = join(dir, "home", "runs", "C--proj-repo", "m-1");
      equal(loadManifest(p, CFG_PROJ, dir, { io }).resultsDir, want);
      equal(loadManifest(p, CFG_PROJ, sub, { io }).resultsDir, want);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run home: allowedRoots bounds the repo for a Claude-only manifest too", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      // Claude's OWN roots, nested spelling — the legacy top-level `provider` key resolves
      // onto ollama and has no say over a Claude-only run.
      const root = join(dir, "root");
      const inside = join(root, "repo");
      mkdirSync(inside, { recursive: true });
      const cfg = { ...CFG, providers: { claude: { enabled: true, allowedRoots: [root] } } };
      const p = writeManifest(dir, { tasks: [claudeTask({ cwd: inside })] });
      const outside = join(dir, "elsewhere");
      const errs = errorsOf(() => loadManifest(p, cfg, inside, { io: { repoToplevel: () => outside } }));
      ok(errs.some((e) => e.includes(`this run's repo '${outside}'`) && e.includes("providers.claude.allowedRoots") && e.includes(root)), errs.join("\n"));
      loadManifest(p, cfg, inside, { io: { repoToplevel: () => inside } });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Fail-open by design, as it always was: no roots declared for the providers a run seats
// states no policy, so the run gate adds nothing. checkGovernance still denies every leaf
// whose provider has no roots — the run is refused, just not by this gate.
test("run home: absent or empty allowedRoots leaves the run gate inert", () => {
  const dir = tmp();
  try {
    withHome(dir, () => {
      const p = writeManifest(dir, { tasks: [claudeTask()] });
      const io = { repoToplevel: () => join(dir, "anywhere") };
      const configs = [{ claude: { enabled: true } }, { claude: { enabled: true, allowedRoots: [] } }];
      for (const providers of configs) {
        const errs = errorsOf(() => loadManifest(p, { ...CFG, providers }, dir, { io }));
        ok(!errs.some((e) => e.includes("this run's repo")), errs.join("\n"));
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real git, not the io stub: the stub IS realRepoToplevel's replacement, so only a
// genuine linked worktree can turn this red. Under `rev-parse --show-toplevel` the
// worktree answers with itself and the run home nests inside a previous run's tree.
test("realRepoToplevel: a linked worktree resolves to the MAIN worktree, not itself", () => {
  const dir = realpathSync(tmp());
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (args, cwd = repo) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    const wt = join(dir, "wt");
    git(["worktree", "add", "-q", "-b", "side", wt]);

    const norm = (p) => p.split("\\").join("/");
    equal(norm(realRepoToplevel(wt)), norm(repo));
    equal(norm(realRepoToplevel(repo)), norm(repo));

    // A nested dir inside the linked worktree resolves the same way.
    const deep = join(wt, "sub");
    mkdirSync(deep);
    equal(norm(realRepoToplevel(deep)), norm(repo));

    git(["worktree", "remove", "--force", wt]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("realRepoToplevel: outside a repo is null", () => {
  const dir = realpathSync(tmp());
  try {
    equal(realRepoToplevel(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the one derivation: rows pinned to literals / the independent run-scope oracle ----
import { effectivePlanDoc } from "../src/manifest.mjs";
import { oracleSnapKey } from "./helpers/snap-key.mjs";

const bashTask = (over = {}) => ({ id: "impl", prompt: "p", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Bash", ...over });
const inDir = (dir, body, name, opts) => loadManifest(writeManifest(dir, body, name), CFG, dir, opts);

test("branchScope: every writer carries the run-scoped key, however its tree was named; readers carry none", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [
      bashTask(),
      claudeTask({ id: "rd" }),
      bashTask({ id: "ex", workspace: "shared" }),
    ] });
    const by = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    ok(/^[0-9a-f]{12}$/.test(by.impl.branchScope), by.impl.branchScope);
    equal(by.impl.branchScope, oracleSnapKey(plan.resultsDir));
    equal(by.impl.branchName, undefined);
    equal(by.rd.branchScope, undefined, "a reader owns no branch to scope");
    // The row the plan exists for: naming the tree must not change the derivation.
    equal(by.ex.branchScope, oracleSnapKey(plan.resultsDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branchScope: a forEach writer synthesises worktreeName so clones can be renamed, and no fixed branchName", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [
      claudeTask({ id: "src" }),
      bashTask({ id: "fe", after: ["src"], forEach: { from: "src", path: "sites", maxItems: 2 } }),
    ] });
    const fe = plan.tasks.find((t) => t.id === "fe");
    equal(fe.worktreeName, "fe");
    equal(fe.branchName, undefined);
    equal(fe.branchScope, oracleSnapKey(plan.resultsDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer beside a workspace of the same name is a collision; a reader is not", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => inDir(dir, { tasks: [
      bashTask(),
      bashTask({ id: "other", workspace: "impl" }),
    ] }));
    ok(errs.some((e) => e.includes("collides with task 'impl'")), errs.join("\n"));
    const plan = inDir(dir, { tasks: [
      claudeTask({ id: "impl" }),
      bashTask({ id: "other", workspace: "impl" }),
    ] }, "ok.json");
    equal(plan.tasks.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader is normalised with no tree and its cwd untouched", () => {
  const dir = tmp();
  try {
    const t = inDir(dir, { tasks: [claudeTask()] }).tasks[0];
    equal(t.worktreeName, undefined);
    equal(t.branchScope, undefined);
    equal(t.checkoutToplevel, undefined, "a reader needs no repo: it is not getting a tree from one");
    equal(t.cwd, t.originalCwd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader outside any repo loads: only a writer needs one", () => {
  // RED: apply the repo check to every leaf and a leaf reading a non-repo directory —
  // logs, a data dump — is refused for wanting a tree it never asked for.
  const dir = tmp();
  const bare = join(dir, "bare");
  mkdirSync(bare);
  const top = (c) => (c === bare ? null : dir), io = { repoToplevel: top, checkoutToplevel: top };
  try {
    equal(loadManifest(writeManifest(dir, { tasks: [claudeTask({ cwd: bare })] }), CFG, dir, { io }).tasks.length, 1);

    const errs = errorsOf(() => loadManifest(
      writeManifest(dir, { tasks: [bashTask({ cwd: bare })] }, "w.json"), CFG, dir, { io }));
    ok(errs.some((e) => e.includes("is not inside a git repository") && e.includes("drop the write tools")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectivePlanDoc records what was authored: workspace and branch kept, nothing synthesised", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [
      claudeTask({ id: "rd" }),
      bashTask({ id: "wr" }),
      bashTask({ id: "ws", workspace: "feat" }),
      bashTask({ id: "br", branch: "autonomous/x" }),
    ] });
    const by = Object.fromEntries(effectivePlanDoc(plan).tasks.map((t) => [t.id, t]));
    equal("workspace" in by.rd, false);
    equal("workspace" in by.wr, false, "a derived tree is not authored, so it is not recorded");
    equal(by.ws.workspace, "feat");
    equal(by.br.branch, "autonomous/x");
    for (const t of Object.values(by)) equal("isolationMode" in t, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two default readers with no after: neither owns a worktree name, so they are not an ordered group", () => {
  const dir = tmp();
  try {
    const plan = inDir(dir, { tasks: [claudeTask({ id: "r1" }), claudeTask({ id: "r2" })] });
    const by = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    for (const id of ["r1", "r2"]) {
      equal("worktreeName" in by[id], false, "a shared name would make two parallel readers a chain");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forEach writer's clone names collide with a workspace sibling", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => inDir(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      bashTask({ id: "fix", after: ["src"], forEach: { from: "src", path: "", maxItems: 2 },
        prompt: "fix {{item}}" }),
      bashTask({ id: "other", workspace: "fix-1" }),
    ] }));
    ok(errs.some((e) => e.includes('forEach clone worktree "fix-1" would collide')), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrate.from: a reader has no branch to merge; a writer does", () => {
  const dir = tmp();
  try {
    const errs = errorsOf(() => inDir(dir, { tasks: [
      claudeTask({ id: "x" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
    ] }));
    ok(errs.some((e) => e.includes("integrate.from 'x' has no write tools")), errs.join("\n"));

    const plan = inDir(dir, { tasks: [
      bashTask({ id: "x" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
    ] }, "ok.json");
    deepEqual(plan.tasks.find((t) => t.id === "join").integrate.from, ["x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest records the dispatching repo on the plan", () => {
  const dir = tmp();
  try {
    equal(inDir(dir, { tasks: [claudeTask()] }).repoToplevel, dir, "the run is filed under this tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer in a second repo carries THAT repo, while the run stays filed under the dispatching one", () => {
  const dir = tmp(), other = tmp();
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    // Two real repos: the dispatch cwd and the task's own.
    const top = (d) => (String(d).startsWith(other) ? other : dir), io = { repoToplevel: top, checkoutToplevel: top };
    const plan = inDir(dir, { tasks: [
      bashTask({ id: "here" }),
      bashTask({ id: "there", cwd: other }),
    ] }, "two.json", { io });
    const by = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    equal(by.here.checkoutToplevel, dir);
    equal(by.there.checkoutToplevel, other);
    notEqual(by.there.checkoutToplevel, by.here.checkoutToplevel, "one repo for both branches the wrong tree");
    equal(plan.repoToplevel, dir, "the run is filed under the dispatching repo, not the task's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("writers sharing a cwd ask git for its toplevel once, not once per task", () => {
  const dir = tmp();
  try {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    const calls = [];
    const io = { repoToplevel: () => dir, checkoutToplevel: (d) => { calls.push(String(d)); return dir; } };
    const tasks = Array.from({ length: 10 }, (_, i) => bashTask({ id: `t${i}`, cwd: "sub" }));
    inDir(dir, { tasks }, "memo.json", { io });
    equal(calls.filter((d) => d === sub).length, 1,
      "no memo means one `git rev-parse` per leaf at normalise time — slow, and invisible to every other test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── leaf write guard ──────────────────────────────────────────────────────────
// A worktree confines a leaf's cwd, not an absolute path: the 2026-08-28 incident
// was a compacted leaf writing across the operator's live checkout. The guard is
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
