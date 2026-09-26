// The one derivation: branch scope, tree-name collisions and the authored plan
// doc, pinned to literals alongside the independent run-scope oracle.
import { test } from "node:test";
import { equal, ok, deepEqual, notEqual } from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { effectivePlanDoc } from "../src/manifest.mjs";
import { oracleSnapKey } from "./helpers/snap-key.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";

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
