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

test("fallbackModel: governed like the primary; passes through to the task", () => {
  const dir = tmp();
  try {
    // open-model fallback outside allowedRoots -> validation error
    const p1 = writeManifest(dir, { tasks: [claudeTask({ fallbackModel: "glm-4.6:cloud" })] });
    const errs = errorsOf(() => loadManifest(p1, CFG, dir));
    ok(errs.some((e) => e.includes("fallback") && e.includes("governance")), errs.join("\n"));

    // claude fallback is fine anywhere and lands on the normalized task
    const p2 = writeManifest(dir, { tasks: [claudeTask({ model: "sonnet", fallbackModel: "haiku" })] }, "ok.json");
    const plan = loadManifest(p2, CFG, dir);
    equal(plan.tasks[0].fallbackModel, "haiku");

    // non-string fallback rejected
    const p3 = writeManifest(dir, { tasks: [claudeTask({ fallbackModel: 42 })] }, "bad.json");
    ok(errorsOf(() => loadManifest(p3, CFG, dir)).some((e) => e.includes("fallbackModel")), "type error surfaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// ── deterministic steps: compute / when / forEach ─────────────────────────────

test("compute: valid task normalizes agentless with the expression carried", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "dedupe", after: ["scan"], compute: "unique_by(deps['scan'].sites, 'file')" },
      ],
    });
    // allowedRoots is empty — a compute step spawns nothing, so no governance
    const plan = loadManifest(p, CFG, dir);
    const dd = plan.tasks.find((t) => t.id === "dedupe");
    equal(dd.compute, "unique_by(deps['scan'].sites, 'file')");
    equal(dd.model, "compute");
    equal(hasWriteTools(dd.allowedTools), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: agentless — model/prompt rejected, forEach mutually exclusive, string required", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "c1", after: ["scan"], compute: "count(deps.scan.xs)", model: "haiku", prompt: "p" },
        { id: "c2", after: ["scan"], compute: "count(deps.scan.xs)", forEach: { from: "scan", maxItems: 2 } },
        { id: "c3", after: ["scan"], compute: 42 },
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("c1") && e.includes("agentless")), errs.join("|"));
    ok(errs.some((e) => e.includes("c2") && e.includes("forEach") && e.includes("compute")), errs.join("|"));
    ok(errs.some((e) => e.includes("c3") && e.includes("string")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: expression errors embed the teaching message with caret", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ id: "scan" }), { id: "dedupe", after: ["scan"], compute: "nope(deps.scan)" }],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const hit = errs.find((e) => e.includes("unknown function 'nope'"));
    ok(hit, errs.join("|"));
    ok(hit.includes("dedupe"), hit);
    ok(hit.includes("^"), hit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compute: deps refs must be declared deps; dynamic access and 'value' rejected", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "g", after: ["scan"], compute: "unique_by(deps['ghost'].sites, 'f')" },
        { id: "d", after: ["scan"], compute: "length(deps) > 0" },
        { id: "v", after: ["scan"], compute: "length(value) > 0" },
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("'ghost'") && e.includes("after")), errs.join("|"));
    ok(errs.some((e) => e.includes("task 'd'") && e.includes("literal")), errs.join("|"));
    ok(errs.some((e) => e.includes("task 'v'") && e.includes("'value'") && e.includes("when")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: valid gate carried through; composes with forEach", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "gate", after: ["scan"], when: { from: "scan", expr: "length(value) > 2" } }),
        claudeTask({
          id: "fan", after: ["scan"],
          when: { from: "scan", expr: "length(value) > 0" },
          forEach: { from: "scan", maxItems: 5 },
          prompt: "handle {{item}}",
        }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    deepEqual(plan.tasks.find((t) => t.id === "gate").when, { from: "scan", expr: "length(value) > 2" });
    const fan = plan.tasks.find((t) => t.id === "fan");
    deepEqual(fan.when, { from: "scan", expr: "length(value) > 0" });
    deepEqual(fan.forEach, { from: "scan", path: "", maxItems: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when: shape errors teach — from/expr required, from in after, value-only scope, no stray keys", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "other" }),
        claudeTask({ id: "w1", after: ["scan"], when: { expr: "true" } }),
        claudeTask({ id: "w2", after: ["scan"], when: { from: "scan" } }),
        claudeTask({ id: "w3", after: ["scan"], when: { from: "other", expr: "true" } }),
        claudeTask({ id: "w4", after: ["scan"], when: { from: "scan", expr: "1 +" } }),
        claudeTask({ id: "w5", after: ["scan"], when: { from: "scan", expr: "deps.scan.n > 0" } }),
        claudeTask({ id: "w6", after: ["scan"], when: { from: "scan", expr: "true", if: "x" } }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("w1") && e.includes("when.from is required")), errs.join("|"));
    ok(errs.some((e) => e.includes("w2") && e.includes("when.expr is required")), errs.join("|"));
    ok(errs.some((e) => e.includes("w3") && e.includes("after")), errs.join("|"));
    ok(errs.some((e) => e.includes("w4") && e.includes("arithmetic")), errs.join("|"));
    ok(errs.some((e) => e.includes("w5") && e.includes("'value'") && e.includes("compute")), errs.join("|"));
    ok(errs.some((e) => e.includes("w6") && e.includes("unknown key 'if'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: valid block carried; path defaults to empty; template placeholders allowed", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        { id: "dedupe", after: ["scan"], compute: "unique_by(deps['scan'].sites, 'file')" },
        claudeTask({
          id: "fix", after: ["dedupe"],
          forEach: { from: "dedupe", path: "sites", maxItems: 30 },
          prompt: "Fix {{item.file}} (clone {{index}}) using {{result:dedupe}}",
        }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    deepEqual(plan.tasks.find((t) => t.id === "fix").forEach, { from: "dedupe", path: "sites", maxItems: 30 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: maxItems is the approval cap — required, positive integer", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "f1", after: ["scan"], forEach: { from: "scan" } }),
        claudeTask({ id: "f2", after: ["scan"], forEach: { from: "scan", maxItems: 0 } }),
        claudeTask({ id: "f3", after: ["scan"], forEach: { from: "scan", maxItems: "30" } }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const req = errs.find((e) => e.includes("f1") && e.includes("maxItems is required"));
    ok(req, errs.join("|"));
    ok(/approval/.test(req), req);
    ok(errs.some((e) => e.includes("f2") && e.includes("positive integer")), errs.join("|"));
    ok(errs.some((e) => e.includes("f3") && e.includes("positive integer")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forEach: from required and declared in after; no stray keys", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "scan" }),
        claudeTask({ id: "other" }),
        claudeTask({ id: "f1", after: ["scan"], forEach: { maxItems: 3 } }),
        claudeTask({ id: "f2", after: ["scan"], forEach: { from: "other", maxItems: 3 } }),
        claudeTask({ id: "f3", after: ["scan"], forEach: { from: "scan", maxItems: 3, filter: "x" } }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("f1") && e.includes("forEach.from is required")), errs.join("|"));
    ok(errs.some((e) => e.includes("f2") && e.includes("after")), errs.join("|"));
    ok(errs.some((e) => e.includes("f3") && e.includes("unknown key 'filter'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("{{item}}/{{index}} placeholders demand a forEach block", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "a", prompt: "do {{item.file}}" }),
        claudeTask({ id: "b", prompt: "n {{index}}" }),
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("'a'") && e.includes("forEach")), errs.join("|"));
    ok(errs.some((e) => e.includes("'b'") && e.includes("forEach")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[n]-suffixed ids are reserved for forEach clones", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ id: "fix[0]" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("reserved") && e.includes("clone")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown task keys rejected with the known-key list (catches the foreach typo)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ foreach: { from: "x", maxItems: 1 } })],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const hit = errs.find((e) => e.includes("unknown key 'foreach'"));
    ok(hit, errs.join("|"));
    ok(hit.includes("forEach"), hit); // the known-key list shows the casing fix
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

// ── returns (schema-validated output) ─────────────────────────────────────────

test("returns: accepted on a leaf and a forEach task, carried through normalization", () => {
  const dir = tmp();
  try {
    const schema = { type: "object", required: ["sites"], properties: { sites: { type: "array" } } };
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ returns: schema }),
        claudeTask({
          id: "per", prompt: "check {{item}}", after: ["a"],
          forEach: { from: "a", path: "sites", maxItems: 3 },
          returns: { type: "string" },
        }),
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    deepEqual(plan.tasks[0].returns, schema);
    deepEqual(plan.tasks[1].returns, { type: "string" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns on a compute task is rejected — point it at the producing leaf", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [
        claudeTask(),
        { id: "dedupe", compute: "unique_by(deps['a'], 'file')", after: ["a"], returns: { type: "array" } },
      ],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'dedupe'") && e.includes("engine-deterministic") && e.includes("leaf")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns must be an object — teaching error carries an inline example", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ returns: "json" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'a'") && e.includes("returns must be an object") && e.includes('"type"')), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns: schema shape errors surface per problem with the task label", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask({ returns: { type: "list", additionalProperties: false } })],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'a'") && e.includes("type 'list' is not supported")), errs.join("\n"));
    ok(errs.some((e) => e.includes("task 'a'") && e.includes("unknown keyword 'additionalProperties'")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the unknown-key message now lists returns (typo teaching)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ return: { type: "array" } })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    const hit = errs.find((e) => e.includes("unknown key 'return'"));
    ok(hit, errs.join("|"));
    ok(hit.includes("returns"), hit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
