// Workspace and branch: how a task names the tree it runs in, how that name is
// run-scoped, and the ordering and collision rules the shared surface imposes.
import { test } from "node:test";
import { equal, ok, deepEqual, match } from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask, writerTask } from "./helpers/manifest-fixtures.mjs";

test("workspace normalizes to a shared tree name; silence means the task's own id", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "p1", workspace: "feat" }),
      writerTask({ id: "p2", after: ["p1"], workspace: "feat" }),
      writerTask({ id: "solo" }),
    ] });
    const plan = loadManifest(p, CFG, dir);
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    equal(byId.p1.worktreeName, "feat");
    equal(byId.p2.worktreeName, "feat");
    equal(byId.solo.worktreeName, "solo", "no workspace means the task's own id");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace rejects an empty or non-filename-safe name", () => {
  const dir = tmp();
  try {
    const bad = writeManifest(dir, { tasks: [writerTask({ workspace: "" })] }, "b1.json");
    ok(errorsOf(() => loadManifest(bad, CFG, dir)).some((e) => /non-empty string/i.test(e)));

    const unsafe = writeManifest(dir, { tasks: [writerTask({ workspace: "a/b" })] }, "b2.json");
    ok(errorsOf(() => loadManifest(unsafe, CFG, dir)).some((e) => /filename-safe/i.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared workspace is still run-scoped: naming a tree is not opting out of scoping", () => {
  // RED: skip branchScope when workspace is written, and a kept tree from the last run
  // of this manifest blocks the next at `worktree add` — the #297 defect by the other
  // spelling. Only an explicit `branch` opts out.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writerTask({ id: "p1", workspace: "feat" })] });
    const t = loadManifest(p, CFG, dir).tasks[0];
    ok(t.branchScope, "a derived branch is always run-scoped");
    equal(t.worktreeName, "feat");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tasks sharing a workspace must be totally ordered", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "p1", workspace: "feat" }),
      writerTask({ id: "p2", after: ["p1"], workspace: "feat" }),
      writerTask({ id: "p3", after: ["p1"], workspace: "feat" }),
    ] });
    const msg = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(/'p2'.*'p3'|'p3'.*'p2'/.test(msg), `expected the unordered pair named: ${msg}`);
    ok(/after/.test(msg), "error must name the fix");
    ok(/"workspace"/.test(msg), "error must show a correct example");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forEach cannot name a shared workspace", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "find" }),
      writerTask({ id: "fix", after: ["find"], workspace: "feat",
        forEach: { from: "find", path: "", maxItems: 5 } }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /forEach.*shared workspace|shared workspace.*forEach/i.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared workspace name cannot collide with another task's own tree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "feat" }),
      writerTask({ id: "p1", workspace: "feat" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /collide|same path|already/i.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a forEach task's future clone worktree cannot collide with a real task's own worktree", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      claudeTask({ id: "find" }),
      writerTask({ id: "fix", after: ["find"],
        forEach: { from: "find", path: "", maxItems: 3 } }),
      // expandForEach will mint "fix"'s clones as fix-0/fix-1/fix-2 —
      // a real task that already owns "fix-1" must be rejected up front,
      // since neither name can be reserved against the other.
      writerTask({ id: "fix-1" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /forEach clone worktree "fix-1"/.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("links sharing a workspace must agree on their branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "impl", workspace: "feat", branch: "autonomous/x" }),
      writerTask({ id: "rev", after: ["impl"], workspace: "feat" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    ok(errs.some((e) => /disagree on their branch/.test(e) && /autonomous\/x/.test(e)), JSON.stringify(errs));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("links sharing a workspace with the SAME explicit branch are fine", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "impl", workspace: "feat", branch: "autonomous/x" }),
      writerTask({ id: "rev", after: ["impl"], workspace: "feat", branch: "autonomous/x" }),
    ] });
    equal(loadManifest(p, CFG, dir).tasks.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an ordered chain of three passes validation", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "p1", workspace: "feat" }),
      writerTask({ id: "rev", after: ["p1"], workspace: "feat" }),
      writerTask({ id: "p2", after: ["rev"], workspace: "feat" }),
    ] });
    const plan = loadManifest(p, CFG, dir);
    equal(plan.tasks.length, 3);
    deepEqual(plan.tasks.map((t) => t.worktreeName), ["feat", "feat", "feat"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- workspace and branch: the whole isolation surface ------------------------


test("workspace: a writer gets one tree named by it, on a run-scoped branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writerTask({ workspace: "feat" })] });
    const [t] = loadManifest(p, CFG, dir).tasks;
    equal(t.worktreeName, "feat");
    ok(t.branchScope, "a derived branch is run-scoped so a kept tree cannot block the next run");
    equal(t.checkoutToplevel !== undefined, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: naming your own id is identical to writing nothing", () => {
  // RED: reintroduce a second derivation branch for the explicit spelling and these diverge.
  // Deep-equal on the WHOLE task, not a field list — a field list missed branchScope last time.
  // One manifest, so both tasks share a resultsDir and therefore a run scope; only the id
  // is expected to differ.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "silent" }),
      writerTask({ id: "named", workspace: "named", after: ["silent"] }),
    ] });
    const [silent, named] = loadManifest(p, CFG, dir).tasks;
    // The authored keys and the ids differ by construction; every DERIVED field must not.
    // The write guard's allowed root IS the task's own tree, so it differs exactly where
    // worktreeName does — normalise that one substring rather than dropping `settings`,
    // so any other divergence in the block still fails.
    const derivedOnly = (t) => {
      const { id, after, workspace, worktreeName, ...rest } = t;
      return JSON.parse(JSON.stringify(rest).split(`wt-${worktreeName}`).join("wt-<name>"));
    };
    deepEqual(derivedOnly(named), derivedOnly(silent));
    // And the names still agree, so the two spellings really do describe one tree.
    equal(named.worktreeName, "named");
    equal(silent.worktreeName, "silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: a reader gets no tree and reads its own cwd", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask()] });
    const [t] = loadManifest(p, CFG, dir).tasks;
    equal(t.worktreeName, undefined, "a reader owns no tree");
    equal(t.branchScope, undefined);
    equal(t.cwd, t.originalCwd, "a reader reads the live repo where it was pointed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: isolation is rejected by name and taught workspace", () => {
  const dir = tmp();
  try {
    for (const iso of ["worktree", "none", { worktree: "feat" }]) {
      const p = writeManifest(dir, { tasks: [writerTask({ isolation: iso })] }, `x${JSON.stringify(iso).length}.json`);
      const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
      ok(/isolation/.test(errs), `names the dead key for ${JSON.stringify(iso)}`);
      ok(/workspace/.test(errs), `names the replacement for ${JSON.stringify(iso)}`);
      ok(/"workspace":\s*"/.test(errs), `shows a correct example for ${JSON.stringify(iso)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: a path-escaping name is refused — it becomes a directory and a branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writerTask({ workspace: "../escape" })] });
    ok(errorsOf(() => loadManifest(p, CFG, dir)).join("\n").match(/filename-safe/));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: unordered members of one workspace are refused, naming both", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "a", workspace: "feat" }),
      writerTask({ id: "b", workspace: "feat" }),
    ] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(!/unknown key/.test(errs), `must fail on the ordering rule, not the key allowlist: ${errs}`);
    ok(/\ba\b/.test(errs) && /\bb\b/.test(errs), errs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: ordered members of one workspace share it", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [
      writerTask({ id: "a", workspace: "feat" }),
      writerTask({ id: "b", workspace: "feat", after: ["a"] }),
    ] });
    const ts = loadManifest(p, CFG, dir).tasks;
    deepEqual(ts.map((t) => t.worktreeName), ["feat", "feat"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch: an explicit name is carried verbatim and opts out of run scoping", () => {
  // RED: drop branchName from the normalised task, or keep scoping it — either
  // makes the key decorative, which is the defect class this plan is about.
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [writerTask({ branch: "swarm/eco-p3" })] });
    const [t] = loadManifest(p, CFG, dir).tasks;
    equal(t.branchName, "swarm/eco-p3");
    equal(t.branchScope, undefined, "naming a stable branch IS opting out of the run scope");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch: refused on a reader, which owns no branch", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ branch: "swarm/x" })] });
    const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
    ok(!/unknown key/.test(errs), `branch is a known key; it must be refused on the reader: ${errs}`);
    ok(/branch/.test(errs), errs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace: refused on the agentless nodes, not silently ignored", () => {
  const dir = tmp();
  try {
    for (const [name, over] of [
      ["compute", { compute: "deps['a'].x" }],
      ["integrate", { integrate: { into: "feat", from: ["a"] } }],
    ]) {
      const p = writeManifest(dir, { tasks: [
        writerTask({ id: "a" }),
        { id: "n", after: ["a"], workspace: "feat", ...over },
      ] }, `${name}.json`);
      const errs = errorsOf(() => loadManifest(p, CFG, dir)).join("\n");
      ok(!/unknown key 'workspace'/.test(errs), `${name} must reject it as agentless, not as unknown: ${errs}`);
      ok(/workspace/.test(errs), `${name} must name workspace: ${errs}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
