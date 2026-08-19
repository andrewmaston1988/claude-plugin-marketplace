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

test("digest.report: true and a steering string both survive to the plan", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { model: "haiku", report: true },
    });
    equal(loadManifest(p, CFG, dir).digest.report, true);

    const p2 = writeManifest(dir, {
      tasks: [claudeTask()],
      digest: { model: "haiku", report: "Lead with the security findings." },
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
      digest: { model: "haiku", report: 3 },
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
      digest: { model: "haiku", report: "Lead with {{args.area}}." },
    });
    const plan = loadManifest(p, CFG, dir, { args: { area: "auth" } });
    equal(plan.digest.report, "Lead with auth.");
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

// ── child manifests (bounded composition) ─────────────────────────────────────

const CHILD = {
  tasks: [
    { id: "scan", prompt: "look at {{item}}", model: "haiku" },
    { id: "sum", prompt: "compress {{result:scan}}", model: "haiku", after: ["scan"] },
  ],
};

test("manifest task: child loads, validates, and lands normalized on childPlan", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify(CHILD));
    const p = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "seed" }),
        { id: "audit", manifest: "child.json", after: ["seed"], forEach: { from: "seed", path: "", maxItems: 3 } },
      ],
    });
    const plan = loadManifest(p, CFG, dir);
    const node = plan.tasks.find((t) => t.id === "audit");
    equal(node.model, "manifest");
    equal(node.childPlan.tasks.length, 2);
    equal(node.childPlan.tasks[0].id, "scan");
    equal(node.childPlan.tasks[0].allowedTools, DEFAULT_TOOLS);
    deepEqual(node.childPlan.tasks[1].after, ["scan"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest task: agentless container — leaf keys on the node are rejected", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify(CHILD));
    const p = writeManifest(dir, {
      tasks: [{
        id: "audit", manifest: "child.json", model: "haiku", prompt: "x",
        returns: { type: "object" }, after: [],
      }],
    });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    for (const key of ["model", "prompt", "returns"]) {
      ok(errs.some((e) => e.includes("task 'audit'") && e.includes(key) && e.includes("agentless container")), `${key}:\n${errs.join("\n")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child manifests may not set resultsDir/concurrency/digest — the parent owns the run", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      ...CHILD, resultsDir: "out", concurrency: 2, digest: { model: "haiku" },
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    for (const key of ["resultsDir", "concurrency", "digest"]) {
      ok(errs.some((e) => e.includes(key) && e.includes("parent owns the run")), `${key}:\n${errs.join("\n")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one nesting level: a manifest task inside a child errors naming both files", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "grandchild.json"), JSON.stringify({ tasks: [claudeTask()] }));
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "deep", manifest: "grandchild.json" }],
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("one nesting level") && e.includes("child.json")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child task errors surface in the parent's validate output, prefixed", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "scan", model: "haiku" }], // missing prompt
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("task 'audit' -> child") && e.includes("scan") && e.includes("prompt is required")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("{{item}} in child prompts requires forEach on the parent node", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify(CHILD)); // scan uses {{item}}
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("{{item}}") && e.includes("forEach")), errs.join("\n"));

    const p2 = writeManifest(dir, {
      tasks: [
        claudeTask({ id: "seed" }),
        { id: "audit", manifest: "child.json", after: ["seed"], forEach: { from: "seed", path: "", maxItems: 2 } },
      ],
    }, "ok.json");
    const plan = loadManifest(p2, CFG, dir);
    ok(plan.tasks.find((t) => t.id === "audit").childPlan);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governance gates child tasks exactly like inline tasks", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "child.json"), JSON.stringify({
      tasks: [{ id: "scan", prompt: "x", model: "glm-4.6:cloud" }],
    }));
    const p = writeManifest(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => e.includes("governance") && e.includes("glm-4.6:cloud")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1: named manifests + args ────────────────────────────────────────────────

import { notEqual } from "node:assert/strict";
import { basename } from "node:path";

test("args: substitute into prompts and digest instructions; substituteItems value rendering", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "out",
      tasks: [claudeTask({ prompt: "review {{args.base}} count {{args.n}} cfg {{args.cfg}}" })],
      digest: { model: "haiku", instructions: "focus on {{args.base}}" },
    });
    const plan = loadManifest(p, CFG, dir, { args: { base: "master", n: 7, cfg: { deep: true } } });
    equal(plan.tasks[0].prompt, 'review master count 7 cfg {"deep":true}');
    equal(plan.digest.instructions, "focus on master");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: no placeholders + no args = today's plan, byte-identical (regression pin)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask()] });
    deepEqual(loadManifest(p, CFG, dir, {}), loadManifest(p, CFG, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: unknown placeholder fails validation naming placeholder + supplied keys — never empty-substitutes", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ prompt: "use {{args.missing}}" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { args: { base: "x" } }));
    ok(errs.some((e) => e.includes("{{args.missing}}") && e.includes("base")), errs.join("|"));
    // placeholder with no --args at all is the same failure, not a crash
    const errs2 = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs2.some((e) => e.includes("{{args.missing}}")), errs2.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: supplied key never referenced fails validation (typo protection)", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ prompt: "use {{args.base}}" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { args: { base: "x", extra: "y" } }));
    ok(errs.some((e) => e.includes("'extra'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: smuggled {{result:}} in an arg value hits template validation and dies", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { resultsDir: "out", tasks: [claudeTask({ prompt: "do {{args.payload}}" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir, { args: { payload: "{{result:ghost}}" } }));
    ok(errs.some((e) => e.includes("'ghost'")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args: child manifest prompts participate; unused check spans parent+children; child errors labelled", () => {
  const dir = tmp();
  try {
    writeManifest(dir, { tasks: [{ id: "c1", prompt: "scan {{args.base}}", model: "haiku" }] }, "child.json");
    const p = writeManifest(dir, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child.json" }] });
    // key used only inside the child -> substituted there, no unused error
    const plan = loadManifest(p, CFG, dir, { args: { base: "master" } });
    equal(plan.tasks[0].childPlan.tasks[0].prompt, "scan master");

    // unknown key inside the child -> error carries the child label
    writeManifest(dir, { tasks: [{ id: "c1", prompt: "scan {{args.nope}}", model: "haiku" }] }, "child2.json");
    const p2 = writeManifest(dir, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child2.json" }] }, "plan2.json");
    const errs = errorsOf(() => loadManifest(p2, CFG, dir, { args: {} }));
    ok(errs.some((e) => e.includes("child") && e.includes("{{args.nope}}")), errs.join("|"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry-sourced parent resolves child manifest paths against the parent's dir, not cwd", () => {
  const dirA = tmp(); // where the saved manifest + its child live
  const dirB = tmp(); // the invoking cwd
  try {
    writeManifest(dirA, { tasks: [{ id: "c1", prompt: "scan", model: "haiku" }] }, "child.json");
    const parent = writeManifest(dirA, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child.json" }] }, "parent.json");
    // registry-sourced: child found next to the parent
    const plan = loadManifest(parent, CFG, dirB, { fromRegistry: true });
    equal(plan.tasks[0].childPlan.tasks[0].prompt, "scan");
    // plain path invocation keeps today's cwd resolution -> child not found from dirB
    const errs = errorsOf(() => loadManifest(parent, CFG, dirB));
    ok(errs.some((e) => e.includes("cannot read child manifest")), errs.join("|"));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("args fingerprint keys the default results dir; key order irrelevant; no args = today's stem", () => {
  const dir = tmp();
  const home = tmp();
  const saved = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ prompt: "{{args.a}} {{args.b}}" })] });
    const stemOf = (plan) => basename(plan.resultsDir);
    const a = loadManifest(p, CFG, dir, { args: { b: "x", a: 1 } });
    const b = loadManifest(p, CFG, dir, { args: { a: 1, b: "x" } });
    const c = loadManifest(p, CFG, dir, { args: { a: 2, b: "x" } });
    ok(/^plan\.[0-9a-f]{8}-1$/.test(stemOf(a)), stemOf(a));
    equal(stemOf(a), stemOf(b));
    notEqual(stemOf(a), stemOf(c));
    const plain = writeManifest(dir, { tasks: [claudeTask()] }, "plain.json");
    ok(/^plain-1$/.test(basename(loadManifest(plain, CFG, dir).resultsDir)));
  } finally {
    if (saved === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("isolation object form normalizes to a shared worktree name", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "p1", isolation: { worktree: "feat" } }),
      claudeTask({ id: "p2", after: ["p1"], isolation: { worktree: "feat" } }),
      claudeTask({ id: "solo", isolation: "worktree" }),
    ] });
    const plan = loadManifest(p, CFG, dir);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    equal(byId.p1.worktreeName, "feat");
    equal(byId.p2.worktreeName, "feat");
    equal(byId.solo.worktreeName, "solo", "string form is shorthand for its own id");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isolation object form rejects an empty or non-filename-safe worktree name", () => {
  const dir = tmp();
  try {
    const bad = writeManifest(dir, { tasks: [claudeTask({ isolation: { worktree: "" } })] }, "b1.json");
    ok(errorsOf(() => loadManifest(bad, CFG, dir)).some((e) => /non-empty string/i.test(e)));

    const unsafe = writeManifest(dir, { tasks: [claudeTask({ isolation: { worktree: "a/b" } })] }, "b2.json");
    ok(errorsOf(() => loadManifest(unsafe, CFG, dir)).some((e) => /filename-safe/i.test(e)));

    const junk = writeManifest(dir, { tasks: [claudeTask({ isolation: "nope" })] }, "b3.json");
    ok(errorsOf(() => loadManifest(junk, CFG, dir)).some((e) => /isolation must be/i.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared worktree suppresses the scratch redirect for write-capable leaves", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "p1", isolation: { worktree: "feat" }, allowedTools: "Read,Write" }),
    ] });
    const t = loadManifest(p, CFG, dir).tasks[0];
    equal(t.scratchRedirect, false, "a named worktree is real isolation, not a scratch case");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tasks sharing a worktree must be totally ordered", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "p1", isolation: { worktree: "feat" } }),
      claudeTask({ id: "p2", after: ["p1"], isolation: { worktree: "feat" } }),
      claudeTask({ id: "p3", after: ["p1"], isolation: { worktree: "feat" } }),
    ] });
    const msg = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(/'p2'.*'p3'|'p3'.*'p2'/.test(msg), `expected the unordered pair named: ${msg}`);
    ok(/after/.test(msg), "error must name the fix");
    ok(/"worktree"/.test(msg), "error must show a correct example");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forEach cannot use a shared worktree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "find" }),
      claudeTask({ id: "fix", after: ["find"], isolation: { worktree: "feat" },
        forEach: { from: "find", path: "", maxItems: 5 } }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /forEach.*shared worktree|shared worktree.*forEach/i.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared worktree name cannot collide with a private worktree task id", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "feat", isolation: "worktree" }),
      claudeTask({ id: "p1", isolation: { worktree: "feat" } }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /collide|same path|already/i.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an ordered chain of three passes validation", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "p1", isolation: { worktree: "feat" } }),
      claudeTask({ id: "rev", after: ["p1"], isolation: { worktree: "feat" } }),
      claudeTask({ id: "p2", after: ["rev"], isolation: { worktree: "feat" } }),
    ] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 3);
    deepEqual(plan.tasks.map((t) => t.worktreeName), ["feat", "feat", "feat"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { resolveWorktreeName } from "../src/manifest.mjs";

test("resolveWorktreeName is the single rule every derivation site shares", () => {
  equal(resolveWorktreeName({ id: "a" }), undefined);
  equal(resolveWorktreeName({ id: "a", isolation: "worktree" }), "a");
  equal(resolveWorktreeName({ id: "a", isolation: { worktree: "feat" } }), "feat");
  equal(resolveWorktreeName({ id: "a", isolation: null }), undefined);
  // Already-normalized tasks carry the derived field; it wins over re-derivation.
  equal(resolveWorktreeName({ id: "a", worktreeName: "feat" }), "feat");
});

test("isolation object rejects unknown keys — a typo must never be silently ignored", () => {
  const dir = tmp();
  try {
    // A misspelt or invented key silently hands the leaf a tree the author did
    // not ask for — a wrong answer with no error.
    const bad = writeManifest(dir, { tasks: [
      claudeTask({ id: "c", isolation: { worktree: "feat" } }),
      claudeTask({ id: "d", after: ["c"], isolation: { worktree: "d", basedOn: "c" } }),
    ] }, "unknown-key.json");
    const errs = errorsOf(() => loadManifest(bad, CFG, dir));
    ok(errs.some((e) => /unknown key 'basedOn' in isolation/.test(e)), errs.join("\n"));

    const typo = writeManifest(dir, { tasks: [
      claudeTask({ isolation: { worktree: "feat", worktreeName: "oops" } }),
    ] }, "typo.json");
    ok(errorsOf(() => loadManifest(typo, CFG, dir))
      .some((e) => /unknown key 'worktreeName' in isolation/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isolation.from must name a declared, worktree-isolated dependency", () => {
  const dir = tmp();
  try {
    const notDep = writeManifest(dir, { tasks: [
      claudeTask({ id: "helper", isolation: "worktree" }),
      claudeTask({ id: "x", isolation: { worktree: "x", from: "helper" } }),
    ] }, "notdep.json");
    ok(errorsOf(() => loadManifest(notDep, CFG, dir))
      .some((e) => /must be a declared dependency/.test(e)));

    const noTree = writeManifest(dir, { tasks: [
      claudeTask({ id: "survey" }),
      claudeTask({ id: "x", after: ["survey"], isolation: { worktree: "x", from: "survey" } }),
    ] }, "notree.json");
    ok(errorsOf(() => loadManifest(noTree, CFG, dir))
      .some((e) => /no worktree, so it has no branch/.test(e)));

    const noWrite = writeManifest(dir, { tasks: [
      claudeTask({ id: "review", allowedTools: "Read,Grep,Glob", isolation: { worktree: "brief" } }),
      claudeTask({ id: "x", after: ["review"], isolation: { worktree: "x", from: "review" } }),
    ] }, "nowrite.json");
    ok(errorsOf(() => loadManifest(noWrite, CFG, dir))
      .some((e) => /has no write tools, so it commits nothing/.test(e)),
      "a read-only source commits nothing, so its branch never exists");

    const good = writeManifest(dir, { tasks: [
      claudeTask({ id: "helper", allowedTools: "Read,Edit", isolation: { worktree: "feat" } }),
      claudeTask({ id: "x", after: ["helper"], isolation: { worktree: "x", from: "helper" } }),
    ] }, "good.json");
    const plan = loadManifest(good, CFG, dir);
    equal(plan.tasks.find((t) => t.id === "x").from, "helper");

    // A when-gated source may be skipped at runtime, and a skipped task never
    // reaches prepareIsolation — so its branch is conditional, not guaranteed.
    const gated = writeManifest(dir, { tasks: [
      claudeTask({ id: "probe", prompt: "…return JSON" }),
      claudeTask({ id: "helper", after: ["probe"], allowedTools: "Read,Edit",
        when: { from: "probe", expr: "length(value) > 0" }, isolation: { worktree: "feat" } }),
      claudeTask({ id: "x", after: ["helper"], isolation: { worktree: "x", from: "helper" } }),
    ] }, "gated.json");
    ok(errorsOf(() => loadManifest(gated, CFG, dir))
      .some((e) => /is when-gated/.test(e)),
      "a conditional source owns no branch when its gate is false");

    // Bash-only commits via `git commit` — must not trip the write-tools check.
    const bashOnly = writeManifest(dir, { tasks: [
      claudeTask({ id: "helper", allowedTools: "Bash", isolation: { worktree: "feat" } }),
      claudeTask({ id: "x", after: ["helper"], isolation: { worktree: "x", from: "helper" } }),
    ] }, "bashonly.json");
    equal(loadManifest(bashOnly, CFG, dir).tasks.find((t) => t.id === "x").from, "helper");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integrate node: agentless, validated, normalized onto its target worktree", () => {
  const dir = tmp();
  try {
    const agentic = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", isolation: "worktree" }),
      { id: "join", after: ["x"], model: "haiku", prompt: "merge it",
        integrate: { into: "feat", from: ["x"] } },
    ] }, "agentic.json");
    ok(errorsOf(() => loadManifest(agentic, CFG, dir))
      .some((e) => /integrate tasks are agentless/.test(e)));

    const notDep = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", isolation: "worktree" }),
      { id: "join", integrate: { into: "feat", from: ["x"] } },
    ] }, "notdep.json");
    ok(errorsOf(() => loadManifest(notDep, CFG, dir))
      .some((e) => /must be a declared dependency/.test(e)));

    const noTree = writeManifest(dir, { tasks: [
      claudeTask({ id: "x" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
    ] }, "notree.json");
    ok(errorsOf(() => loadManifest(noTree, CFG, dir))
      .some((e) => /no worktree, so it has no branch to merge/.test(e)));

    const noWriteSrc = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", allowedTools: "Read,Grep,Glob", isolation: "worktree" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
    ] }, "nowritesrc.json");
    ok(errorsOf(() => loadManifest(noWriteSrc, CFG, dir))
      .some((e) => /has no write tools, so it commits nothing/.test(e)),
      "nothing to merge from a branch that never exists");

    const good = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", allowedTools: "Read,Edit", isolation: "worktree" }),
      claudeTask({ id: "y", allowedTools: "Bash", isolation: "worktree" }),
      { id: "join", after: ["x", "y"], integrate: { into: "feat", from: ["x", "y"] } },
      claudeTask({ id: "next", after: ["join"], isolation: { worktree: "feat" } }),
    ] }, "good.json");
    const plan = loadManifest(good, CFG, dir);
    const join = plan.tasks.find((t) => t.id === "join");
    equal(join.model, "integrate", "display sentinel — never dispatched");
    equal(join.worktreeName, "feat", "the node owns the target tree");
    deepEqual(join.integrate.from, ["x", "y"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agentless nodes reject outputDir; from/integrate reject a forEach source", () => {
  const dir = tmp();
  try {
    const od = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", isolation: "worktree" }),
      { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] }, outputDir: "out" },
    ] }, "od.json");
    ok(errorsOf(() => loadManifest(od, CFG, dir)).some((e) => /agentless.*outputDir/.test(e)),
      "integrate rejects outputDir");

    const odc = writeManifest(dir, { tasks: [
      claudeTask({ id: "a", prompt: "…return JSON" }),
      { id: "c", after: ["a"], compute: "deps['a']", outputDir: "out" },
    ] }, "odc.json");
    ok(errorsOf(() => loadManifest(odc, CFG, dir)).some((e) => /agentless.*outputDir/.test(e)),
      "compute rejects outputDir");

    const fe = writeManifest(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      claudeTask({ id: "fan", after: ["src"], isolation: "worktree", allowedTools: "Read,Edit",
        forEach: { from: "src", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      claudeTask({ id: "next", after: ["fan"], isolation: { worktree: "n", from: "fan" } }),
    ] }, "fe.json");
    ok(errorsOf(() => loadManifest(fe, CFG, dir)).some((e) => /is a forEach task/.test(e)),
      "isolation.from rejects a forEach parent");

    const fei = writeManifest(dir, { tasks: [
      claudeTask({ id: "src2", prompt: "…return JSON list" }),
      claudeTask({ id: "fan2", after: ["src2"], isolation: "worktree", allowedTools: "Read,Edit",
        forEach: { from: "src2", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      { id: "join2", after: ["fan2"], integrate: { into: "feat", from: ["fan2"] } },
    ] }, "fei.json");
    ok(errorsOf(() => loadManifest(fei, CFG, dir)).some((e) => /is a forEach task/.test(e)),
      "integrate.from rejects a forEach parent");

    // A read-only forEach parent trips both rules; the forEach one is the more
    // specific diagnosis, so it must be the one reported.
    const feRo = writeManifest(dir, { tasks: [
      claudeTask({ id: "src3", prompt: "…return JSON list" }),
      claudeTask({ id: "fan3", after: ["src3"], isolation: "worktree", allowedTools: "Read,Grep",
        forEach: { from: "src3", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      claudeTask({ id: "next3", after: ["fan3"], isolation: { worktree: "n3", from: "fan3" } }),
    ] }, "fero.json");
    ok(errorsOf(() => loadManifest(feRo, CFG, dir)).some((e) => /is a forEach task/.test(e)),
      "forEach beats no-write-tools — the clones own branches, which is the real fix");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
