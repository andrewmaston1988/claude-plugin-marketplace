import { test } from "node:test";
import { equal, ok, deepEqual, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest, ValidationError, DEFAULT_TOOLS, isUnderRoot, hasWriteTools } from "../src/manifest.mjs";

const CFG = {
  provider: { allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
};

function writeManifest(dir, body, name = "plan.json") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-man-"));
}

function errorsOf(fn) {
  try {
    fn();
  } catch (e) {
    ok(e instanceof ValidationError, `expected ValidationError, got ${e}`);
    return e.errors;
  }
  throw new Error("expected loadManifest to throw");
}

const claudeTask = (over = {}) => ({ id: "a", prompt: "do it", model: "haiku", ...over });

test("fully valid manifest normalizes with defaults", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "out",
      tasks: [
        { id: "scan-a", prompt: "look", model: "haiku" },
        { id: "scan-b", prompt: "look more", model: "sonnet", effort: "max" },
        { id: "join", prompt: "combine {{result:scan-a}} and {{resultPath:scan-b}}", model: "opus", after: ["scan-a", "scan-b"] },
      ],
      digest: { model: "haiku", instructions: "focus on X" },
    });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.resultsDir, join(dir, "out"));
    equal(plan.concurrency, 4);
    equal(plan.tasks.length, 3);
    equal(plan.tasks[0].allowedTools, DEFAULT_TOOLS);
    equal(plan.tasks[0].cwd, dir);
    equal(plan.tasks[0].timeoutMs, 600000);
    deepEqual(plan.tasks[2].after, ["scan-a", "scan-b"]);
    equal(plan.digest.model, "haiku");
    equal(plan.digest.instructions, "focus on X");
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

test("Claude-tier effort matrix enforced; open-model effort passes through", () => {
  const dir = tmp();
  try {
    const bad = writeManifest(dir, {
      tasks: [claudeTask({ effort: "max" })], // haiku has no max
    }, "bad.json");
    const errs = errorsOf(() => loadManifest(bad, CFG, dir));
    ok(errs.some((e) => e.includes("effort 'max'") && e.includes("haiku")), errs.join("|"));

    const cfgAllowed = { ...CFG, provider: { allowedRoots: [dir] } };
    const good = writeManifest(dir, {
      tasks: [
        { id: "o", prompt: "p", model: "glm-4.6:cloud", effort: "xhigh" },
        claudeTask({ id: "s", model: "sonnet", effort: "max" }),
      ],
    }, "good.json");
    const plan = loadManifest(good, cfgAllowed, dir);
    equal(plan.tasks[0].effort, "xhigh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── governance gate ───────────────────────────────────────────────────────────

test("governance: open-model task outside allowedRoots rejected with data governance message", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", model: "minimax-m3:cloud" }],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir)); // allowedRoots: []
    ok(errs.some((e) => e.includes("data governance")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: open-model task under an allowed root passes", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", model: "minimax-m3:cloud" }],
    });
    const cfg = { ...CFG, provider: { allowedRoots: [dir] } };
    const plan = loadManifest(p, cfg, dir);
    equal(plan.tasks[0].model, "minimax-m3:cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: task.cwd (not process cwd) is what's checked", () => {
  const dir = tmp();
  try {
    const inside = join(dir, "allowed", "repo");
    mkdirSync(inside, { recursive: true });
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", model: "minimax-m3:cloud", cwd: inside }],
    });
    const cfg = { ...CFG, provider: { allowedRoots: [join(dir, "allowed")] } };
    const plan = loadManifest(p, cfg, dir);
    equal(plan.tasks[0].cwd, inside);

    const outside = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", model: "minimax-m3:cloud", cwd: dir }],
    }, "outside.json");
    const errs = errorsOf(() => loadManifest(outside, cfg, dir));
    ok(errs.some((e) => e.includes("data governance")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: Claude task anywhere passes with empty allowedRoots", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "h", model: "haiku" }),
        claudeTask({ id: "c", model: "claude-opus-4-8" }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance: non-Claude digest model outside roots rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { model: "glm-4.6:cloud" },
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.startsWith("digest") && e.includes("data governance")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── write-implies-isolation ───────────────────────────────────────────────────

test("write tools without isolation redirect cwd to scratch dir under resultsDir", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "res",
      tasks: [
        claudeTask({ id: "gen", allowedTools: "Read,Write" }),
        claudeTask({ id: "bash", allowedTools: "Bash" }),
        claudeTask({ id: "impl", allowedTools: "Read,Edit,Bash", isolation: "worktree" }),
        claudeTask({ id: "ro", allowedTools: "Read,Grep" }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    equal(byId.gen.cwd, join(dir, "res", "scratch-gen"));
    equal(byId.gen.scratchRedirect, true);
    equal(byId.bash.cwd, join(dir, "res", "scratch-bash"));
    equal(byId.impl.cwd, dir);                 // worktree isolation: no redirect
    equal(byId.impl.scratchRedirect, false);
    equal(byId.ro.cwd, dir);                   // read-only: no redirect
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance checks the ORIGINAL cwd, not the scratch redirect", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "o", prompt: "p", model: "glm-4.6:cloud", allowedTools: "Write" }],
    });
    // scratch redirect lands under resultsDir which is under dir — but the
    // original cwd (dir) is outside allowedRoots, so it must still be denied.
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("data governance")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resultsDir default ────────────────────────────────────────────────────────

test("default resultsDir is <home>/runs/<encoded-cwd>/<stem>-1, reusing highest existing n for resume", () => {
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

test("hasWriteTools detects each write tool, case-insensitive", () => {
  equal(hasWriteTools("Read,Grep"), false);
  equal(hasWriteTools("Read,Edit"), true);
  equal(hasWriteTools("write"), true);
  equal(hasWriteTools("Bash"), true);
  equal(hasWriteTools("NotebookEdit"), true);
  equal(hasWriteTools(undefined), false);
});
