// Named manifests and argument substitution: an args value reaches prompts and
// digest instructions, and an unknown or unused key is refused rather than
// silently substituted away.
import { test } from "node:test";
import { equal, ok, deepEqual, notEqual } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, basename } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

// ── W1: named manifests + args ────────────────────────────────────────────────


test("args: substitute into prompts and digest instructions; substituteItems value rendering", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      resultsDir: "out",
      tasks: [claudeTask({ prompt: "review {{args.base}} count {{args.n}} cfg {{args.cfg}}" })],
      digest: { provider: "claude", model: "claude-haiku-4-5-20251001", instructions: "focus on {{args.base}}" },
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
    writeManifest(dir, { tasks: [{ id: "c1", prompt: "scan {{args.base}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, "child.json");
    const p = writeManifest(dir, { resultsDir: "out", tasks: [{ id: "outer", manifest: "child.json" }] });
    // key used only inside the child -> substituted there, no unused error
    const plan = loadManifest(p, CFG, dir, { args: { base: "master" } });
    equal(plan.tasks[0].childPlan.tasks[0].prompt, "scan master");

    // unknown key inside the child -> error carries the child label
    writeManifest(dir, { tasks: [{ id: "c1", prompt: "scan {{args.nope}}", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, "child2.json");
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
    writeManifest(dirA, { tasks: [{ id: "c1", prompt: "scan", provider: "claude", model: "claude-haiku-4-5-20251001" }] }, "child.json");
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
