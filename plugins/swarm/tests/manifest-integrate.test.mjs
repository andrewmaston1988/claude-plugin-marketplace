// Tree-name derivation and the agentless nodes: the single `resolveWorktreeName`
// rule every site shares, `integrate` normalisation onto its target tree, and
// folding a forEach parent's clone branches back in.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveWorktreeName } from "../src/manifest.mjs";
import { integrateCaps } from "../src/estimate.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask, writerTask } from "./helpers/manifest-fixtures.mjs";

test("resolveWorktreeName is the single rule every derivation site shares", () => {
  const W = "Read,Edit,Bash";
  equal(resolveWorktreeName({ id: "a" }), undefined, "a reader owns no tree");
  equal(resolveWorktreeName({ id: "a", allowedTools: W }), "a", "a writer's tree is its own id");
  equal(resolveWorktreeName({ id: "a", allowedTools: W, workspace: "feat" }), "feat");
  equal(resolveWorktreeName({ id: "a", workspace: "feat" }), undefined,
    "a workspace on a reader is refused at validation, so it derives nothing here either");
  equal(resolveWorktreeName({ id: "a", allowedTools: W, compute: "x" }), undefined);
  // Already-normalized tasks carry the derived field; it wins over re-derivation.
  equal(resolveWorktreeName({ id: "a", worktreeName: "feat" }), "feat");
});

test("integrate node: agentless, validated, normalized onto its target worktree", () => {
  const dir = tmp();
  try {
    const agentic = writeManifest(dir, { tasks: [
      writerTask({ id: "x" }),
      { id: "join", after: ["x"], provider: "claude", model: "claude-haiku-4-5-20251001", prompt: "merge it",
        integrate: { into: "feat", from: ["x"] } },
    ] }, "agentic.json");
    ok(errorsOf(() => loadManifest(agentic, CFG, dir))
      .some((e) => /integrate tasks are agentless/.test(e)));

    const notDep = writeManifest(dir, { tasks: [
      writerTask({ id: "x" }),
      { id: "join", integrate: { into: "feat", from: ["x"] } },
    ] }, "notdep.json");
    ok(errorsOf(() => loadManifest(notDep, CFG, dir))
      .some((e) => /must be a declared dependency/.test(e)));

    // A reader and a "no write tools" source are the same source now — the tools are what
    // give a tree — so one message covers both spellings.
    for (const [name, src] of [
      ["notree", claudeTask({ id: "x" })],
      ["nowritesrc", claudeTask({ id: "x", allowedTools: "Read,Grep,Glob" })],
    ]) {
      const bad = writeManifest(dir, { tasks: [
        src, { id: "join", after: ["x"], integrate: { into: "feat", from: ["x"] } },
      ] }, `${name}.json`);
      ok(errorsOf(() => loadManifest(bad, CFG, dir))
        .some((e) => /has no write tools, so it commits nothing and owns no branch to merge/.test(e)),
        `${name}: nothing to merge from a branch that never exists`);
    }

    const good = writeManifest(dir, { tasks: [
      claudeTask({ id: "x", allowedTools: "Read,Edit" }),
      claudeTask({ id: "y", allowedTools: "Bash" }),
      { id: "join", after: ["x", "y"], integrate: { into: "feat", from: ["x", "y"] } },
      writerTask({ id: "next", after: ["join"], workspace: "feat" }),
    ] }, "good.json");
    const plan = loadManifest(good, CFG, dir);
    const join = plan.tasks.find((t) => t.id === "join");
    equal(join.model, "integrate", "display sentinel — never dispatched");
    equal(join.worktreeName, "feat", "the node owns the target tree");
    deepEqual(join.integrate.from, ["x", "y"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agentless nodes reject outputDir", () => {
  const dir = tmp();
  try {
    const od = writeManifest(dir, { tasks: [
      writerTask({ id: "x" }),
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

  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── F1/F2: integrate.from over a forEach parent (foreach-integrate-fold-back) ──
// integrate MERGES named branches rather than basing a new tree off one, so a
// forEach parent's clone branches ('id[0]', 'id[1]', …) are exactly the kind of
// multi-branch source integrate already knows how to fold in. Only this
// rejection is lifted — isolation.from above still rejects, and the when-gated
// / no-write-tools sibling checks still fire (F2).
test("F1: integrate.from accepts a forEach parent", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      claudeTask({ id: "fix", after: ["src"], allowedTools: "Read,Edit",
        forEach: { from: "src", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      { id: "join", after: ["fix"], integrate: { into: "feat", from: ["fix"] } },
    ] }, "fi.json");
    const plan = loadManifest(p, CFG, dir);
    const join = plan.tasks.find((t) => t.id === "join");
    deepEqual(join.integrate.from, ["fix"], "the clone expansion happens at run time, not here");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F2: integrate.from over a forEach parent still rejects when-gated / no-write-tools sources", () => {
  const dir = tmp();
  try {
    const gated = writeManifest(dir, { tasks: [
      claudeTask({ id: "src", prompt: "…return JSON list" }),
      claudeTask({ id: "fix", after: ["src"], allowedTools: "Read,Edit",
        forEach: { from: "src", path: "", maxItems: 3 }, prompt: "fix {{item}}",
        when: { from: "src", truthy: "ok" } }),
      { id: "join", after: ["fix"], integrate: { into: "feat", from: ["fix"] } },
    ] }, "gated.json");
    ok(errorsOf(() => loadManifest(gated, CFG, dir)).some((e) => /is when-gated/.test(e)),
      "a when-gated forEach source is still refused — its worktree may never exist");

    const noWrite = writeManifest(dir, { tasks: [
      claudeTask({ id: "src2", prompt: "…return JSON list" }),
      claudeTask({ id: "fix2", after: ["src2"], allowedTools: "Read,Grep",
        forEach: { from: "src2", path: "", maxItems: 3 }, prompt: "fix {{item}}" }),
      { id: "join2", after: ["fix2"], integrate: { into: "feat", from: ["fix2"] } },
    ] }, "nowrite.json");
    ok(errorsOf(() => loadManifest(noWrite, CFG, dir)).some((e) => /has no write tools/.test(e)),
      "a read-only forEach source is still refused — its clones commit nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F8: integrateCaps names the forEach cap an integrate node folds in", () => {
  const tasks = [
    { id: "src", provider: "claude", model: "claude-haiku-4-5-20251001" },
    { id: "fix", forEach: { from: "src", path: "", maxItems: 5 } },
    { id: "join", integrate: { into: "feat", from: ["fix"] } },
    { id: "plain", allowedTools: "Read,Edit,Bash" },
    { id: "join2", integrate: { into: "feat2", from: ["plain"] } },
  ];
  deepEqual(integrateCaps(tasks), ["join ≤ 5 branches (fix forEach)"]);
});
