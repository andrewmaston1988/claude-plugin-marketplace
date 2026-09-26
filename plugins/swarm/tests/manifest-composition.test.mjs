// Composition: the schema-validated `returns` contract a leaf hands back, and
// bounded child-manifest nesting under a parent that owns the run.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TOOLS } from "../src/manifest.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";


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
    { id: "scan", prompt: "look at {{item}}", provider: "claude", model: "claude-haiku-4-5-20251001" },
    { id: "sum", prompt: "compress {{result:scan}}", provider: "claude", model: "claude-haiku-4-5-20251001", after: ["scan"] },
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
        id: "audit", manifest: "child.json", provider: "claude", model: "claude-haiku-4-5-20251001", prompt: "x",
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
      ...CHILD, resultsDir: "out", concurrency: 2, digest: { provider: "claude", model: "claude-haiku-4-5-20251001" },
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
      tasks: [{ id: "scan", provider: "claude", model: "claude-haiku-4-5-20251001" }], // missing prompt
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
