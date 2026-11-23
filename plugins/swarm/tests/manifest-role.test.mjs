// `role: "verifier"` — the refusals the field carries, and the warning that catches
// the incident shape whose author never set the field.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { roleErrors, roleWarnings } from "../src/manifest-role.mjs";
import { hasWriteTools } from "../src/manifest-task-policy.mjs";
import { normalizeTasks } from "../src/manifest-normalize.mjs";
import { validateTaskShapes } from "../src/manifest-task-shape.mjs";
import { validateTaskRelations } from "../src/manifest-relations.mjs";
import { effectivePlanDoc } from "../src/manifest.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { loadManifest } from "./helpers/repo-io.mjs";
import { fakeSpawnFactory, makeIo } from "./helpers/fake-io.mjs";
import { CFG, claudeTask, tmp, writeManifest } from "./helpers/manifest-fixtures.mjs";
import { runCliInProcess } from "./helpers/cli.mjs";
import { tmp as repoDir } from "./helpers/cli-fixture.mjs";

const label = (t) => `task '${t.id}'`;
const task = (over = {}) => ({ id: "verify-x", prompt: "report", model: "claude-haiku-4-5-20251001", ...over });

test("row 1: a verifier holding Edit, Write or NotebookEdit is refused, naming the tool and the fix; Bash alone passes", () => {
  for (const [allowedTools, tool] of [
    ["Read,Edit,Bash", "Edit"],
    ["Read,Write", "Write"],
    ["Read,NotebookEdit", "NotebookEdit"],
  ]) {
    const errors = roleErrors([task({ role: "verifier", allowedTools })], label);
    equal(errors.length, 1, `${allowedTools}: ${errors.join("\n")}`);
    ok(errors[0].includes(tool), `the offending tool is named: ${errors[0]}`);
    ok(errors[0].includes("may not hold edit tools"), errors[0]);
    ok(errors[0].includes("Drop Edit/Write/NotebookEdit"), `the fix is spelled: ${errors[0]}`);
    ok(errors[0].includes("keep it and the verifier runs in its own tree"), errors[0]);
  }
  // The contract's own shape: a verifier reads commits with git, in its own tree.
  deepEqual(roleErrors([task({ role: "verifier", allowedTools: "Read,Grep,Glob,Bash" })], label), []);
});

test("row 1: a verifier's own seeded tree, named by no writer, gives no error and no warning", () => {
  const tasks = [
    task({ id: "build", allowedTools: "Read,Edit,Bash" }),
    { id: "seed-verify-x", after: ["build"], integrate: { into: "verify-x", from: ["build"] } },
    task({
      id: "verify-x", role: "verifier", allowedTools: "Read,Grep,Glob,Bash",
      workspace: "verify-x", after: ["build", "seed-verify-x"],
    }),
  ];
  deepEqual(roleErrors(tasks, label), []);
  deepEqual(roleWarnings(tasks, label), []);
});

test("row 2: a verifier holding Bash may name a tree no writer names — its tools do not make that tree a writer's", () => {
  // The premise: Bash puts the verifier in the raw writer set, so a rule that built
  // the set without excluding verifiers would refuse its own private tree.
  ok(hasWriteTools("Read,Grep,Glob,Bash"), "Bash is a write tool");
  deepEqual(
    roleErrors([task({ role: "verifier", allowedTools: "Read,Grep,Glob,Bash", workspace: "verify-x" })], label),
    []
  );
});

test("row 3: a verifier naming a workspace a non-verifier writer also names is refused, with the private-tree form", () => {
  const shared = [
    task({ id: "build", allowedTools: "Read,Edit,Bash", workspace: "feat" }),
    task({ role: "verifier", allowedTools: "Read,Bash", workspace: "feat" }),
  ];
  const errors = roleErrors(shared, label);
  equal(errors.length, 1, errors.join("\n"));
  ok(errors[0].includes("may not name a writers' tree"), errors[0]);
  ok(errors[0].includes('"feat"'), errors[0]);
  // "integrate" alone proves nothing — the old message said it too.
  ok(errors[0].includes('"id": "seed-verify-x"'), `the fix is spelled: ${errors[0]}`);
  ok(errors[0].includes('"after"'), `the seed names its source in after: ${errors[0]}`);
  // Following the message must reach green: a verifier with no Bash gets no tree,
  // and a verifier ordered before its seed reviews an unseeded one.
  ok(errors[0].includes('"allowedTools": "Read,Grep,Glob,Bash"'), `the verifier keeps Bash: ${errors[0]}`);
  ok(errors[0].includes('"seed-verify-x"'), `the verifier waits for the seed: ${errors[0]}`);

  // roleWarnings keeps its set: the same shared tree still warns an id-pattern task
  // that never declared a role.
  const noRole = [
    task({ id: "build", allowedTools: "Read,Edit,Bash", workspace: "feat" }),
    task({ id: "review-x", allowedTools: "Read,Bash", workspace: "feat" }),
  ];
  const warnings = roleWarnings(noRole, label);
  equal(warnings.length, 1, warnings.join("\n"));
  ok(warnings[0].includes(`names the writers' workspace "feat"`), warnings[0]);
});

test("row 3: a verifier naming a writer's derived tree is refused, like naming its workspace", () => {
  // `build` declares no workspace, so its tree is derived from its id — the same
  // directory a verifier naming "build" would join.
  const derived = [
    task({ id: "build", allowedTools: "Read,Edit,Bash" }),
    task({ id: "verify-x", role: "verifier", allowedTools: "Read,Bash", workspace: "build" }),
  ];
  const errors = roleErrors(derived, label);
  equal(errors.length, 1, errors.join("\n"));
  ok(errors[0].includes("may not name a writers' tree"), errors[0]);
  ok(errors[0].includes('"build"'), errors[0]);
  ok(errors[0].includes('"id": "seed-verify-x"'), `the private-tree fix is spelled: ${errors[0]}`);
});

test("row 3: a verifier naming a seeded tree must be ordered after its seed", () => {
  const unseeded = (after) => [
    task({ id: "build", allowedTools: "Read,Edit,Bash" }),
    { id: "seed-verify-x", after: ["build"], integrate: { into: "verify-x", from: ["build"] } },
    task({ id: "verify-x", role: "verifier", allowedTools: "Read,Grep,Glob,Bash", workspace: "verify-x", after }),
  ];
  // Both tasks ready together means the review can read the tree before the merge.
  const errors = roleErrors(unseeded(["build"]), label);
  equal(errors.length, 1, errors.join("\n"));
  ok(errors[0].includes("seed-verify-x"), `the missing edge is named: ${errors[0]}`);
  ok(errors[0].includes("after"), `the fix is spelled: ${errors[0]}`);
  // Either edge clears it: direct, or through a task that already waits for the seed.
  deepEqual(roleErrors(unseeded(["build", "seed-verify-x"]), label), []);
  const through = unseeded(["build", "read-spec"]);
  through.push(task({ id: "read-spec", allowedTools: "Read,Grep,Glob", after: ["seed-verify-x"] }));
  deepEqual(roleErrors(through, label), []);
});

test("row 2c: a reporting verifier is still a legitimate integrate.from source", () => {
  // A reporting leaf is a legitimate merge source: it owns a tree (Bash), so the
  // relation rule accepts it and the role rule adds nothing.
  const tasks = [
    task({ id: "verify-x", role: "verifier", allowedTools: "Read,Bash" }),
    { id: "seed", after: ["verify-x"], integrate: { into: "feat", from: ["verify-x"] } },
  ];
  deepEqual(roleErrors(tasks, label), []);
  deepEqual(roleWarnings(tasks, label), []);
  const relationErrors = [];
  validateTaskRelations(tasks, relationErrors, label);
  deepEqual(relationErrors, []);
});

test("row 2b: the authored role reaches the resolved preview and the run's own snapshot", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "out.keep"), "");
    mkdirSync(join(dir, "out"), { recursive: true });
    const path = writeManifest(dir, { resultsDir: "out", tasks: [
      claudeTask({ id: "verify-x", role: "verifier", allowedTools: "Read,Grep,Glob" }),
      claudeTask({ id: "plain" }),
    ] });
    const plan = loadManifest(path, CFG, dir);
    const by = Object.fromEntries(effectivePlanDoc(plan).tasks.map((t) => [t.id, t]));
    equal(by["verify-x"].role, "verifier", "the field the refusals were judged on is recorded");
    equal("role" in by.plain, false, "a task with no role records none");

    // Read back off a real run: the scheduler writes manifest.json, so this pins its
    // call site, not a copy of it.
    await runPlan(plan, CFG, makeIo(fakeSpawnFactory()));
    const snapshot = JSON.parse(readFileSync(join(dir, "out", "manifest.json"), "utf8"));
    equal(snapshot.tasks.find((t) => t.id === "verify-x").role, "verifier");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The same document is what `validate --resolved` prints for approval.
  const repo = repoDir();
  try {
    const path = join(repo, "m.json");
    writeFileSync(path, JSON.stringify({ tasks: [
      { id: "verify-x", prompt: "report", provider: "claude", model: "claude-haiku-4-5-20251001", allowedTools: "Read,Grep,Glob,Bash", role: "verifier" },
    ] }));
    const r = await runCliInProcess(["validate", path, "--resolved"], { cwd: repo, env: { SWARM_HOME: join(repo, "home") } });
    equal(r.status, 0, r.stdout + r.stderr);
    const resolved = JSON.parse(r.stdout.slice(r.stdout.indexOf("resolved manifest:") + "resolved manifest:".length));
    equal(resolved.tasks[0].role, "verifier", r.stdout);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("row 3: role accepts only the string \"verifier\", and an unknown key is still refused", () => {
  for (const role of ["reviewer", "Verifier", 5, null, ""]) {
    const errors = [];
    validateTaskShapes([task({ role })], errors, label);
    ok(errors.some((e) => e.includes('role must be "verifier"')), `${JSON.stringify(role)}: ${errors.join("\n")}`);
    ok(errors.some((e) => e.includes('"role": "verifier"')), `the fix is spelled inline: ${errors.join("\n")}`);
    ok(!errors.some((e) => e.includes("unknown key")), `role is a known key: ${errors.join("\n")}`);
  }
  const accepted = [];
  validateTaskShapes([task({ role: "verifier" })], accepted, label);
  deepEqual(accepted, []);

  const unknown = [];
  validateTaskShapes([task({ rol: "verifier" })], unknown, label);
  ok(unknown.some((e) => e.includes("unknown key 'rol'")), unknown.join("\n"));
});

test("row 3b: role is a leaf's key — an agentless node carrying it is refused and never carries it", () => {
  const compute = [];
  validateTaskShapes([{ id: "agg", compute: "1 + 1", role: "verifier" }], compute, label);
  ok(compute.some((e) => e.includes("compute tasks are agentless") && e.includes("role")), compute.join("\n"));

  const integrate = [];
  validateTaskShapes([{ id: "join", integrate: { into: "feat", from: ["a"] }, role: "verifier" }], integrate, label);
  ok(integrate.some((e) => e.includes("integrate tasks are agentless") && e.includes("role")), integrate.join("\n"));

  const container = [];
  validateTaskShapes([{ id: "child", manifest: "child.json", role: "verifier" }], container, label);
  ok(container.some((e) => e.includes("agentless container") && e.includes("role")), container.join("\n"));

  // Whatever a hand-built plan says: normalisation never puts the role on a node
  // that spawns no leaf, so `--resolved` cannot approve a constraint nothing holds.
  const dir = tmp();
  try {
    const [normalized] = normalizeTasks([{ id: "agg", compute: "1 + 1", role: "verifier" }], {
      cwd: dir, resultsDir: dir, cfg: CFG, defaultTimeoutMs: 1000, errors: [], label, io: { stdout: () => {} },
    });
    equal("role" in normalized, false, "an agentless node carries no role");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 4: the verifier-prefix warning fires on edits or a shared workspace, never on Bash alone or on the field", () => {
  // (a) an edit tool is what makes a reporting-sounding task a writer.
  const edits = roleWarnings([task({ allowedTools: "Read,Edit,Bash" })], label);
  equal(edits.length, 1, edits.join("\n"));
  ok(edits[0].includes("task 'verify-x' looks like a verifier but can edit"), edits[0]);
  ok(edits[0].includes('"role": "verifier"'), `the fix is spelled: ${edits[0]}`);
  ok(edits[0].includes("rename it if it really writes"), edits[0]);

  // (b) a workspace the writers share is the second half of the same contract.
  const shared = roleWarnings([
    task({ id: "impl", allowedTools: "Read,Edit,Bash", workspace: "feat" }),
    task({ id: "review-x", allowedTools: "Read,Grep,Bash", workspace: "feat" }),
  ], label);
  equal(shared.length, 1, shared.join("\n"));
  ok(shared[0].includes("task 'review-x'"), shared[0]);
  ok(shared[0].includes(`names the writers' workspace "feat"`), shared[0]);

  // (c) the documented phased-chain reviewer: Bash, its own tree, silent.
  deepEqual(roleWarnings([task({ id: "review-phase-1", allowedTools: "Read,Grep,Bash" })], label), []);

  // (d) only the three verifier prefixes are a signal.
  deepEqual(roleWarnings([task({ id: "find-x", allowedTools: "Read,Edit" })], label), []);

  // (e) a task that declares the role is the refusals' business, never the warning's.
  deepEqual(roleWarnings([task({ role: "verifier", allowedTools: "Read,Edit" })], label), []);
});
