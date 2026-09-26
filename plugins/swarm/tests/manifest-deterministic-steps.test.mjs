// Deterministic steps: compute, when and forEach — the agentless nodes whose shape,
// expressions and refs are validated at load time.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { rmSync } from "node:fs";
import { hasWriteTools } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

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
        { id: "c1", after: ["scan"], compute: "count(deps.scan.xs)", provider: "claude", model: "claude-haiku-4-5-20251001", prompt: "p" },
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

